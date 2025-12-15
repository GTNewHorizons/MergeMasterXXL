import _ from "lodash";
import { abort_merge, checkout_branch, checkout_new_branch, checkout_pr, clone_repo, commit, delete_branch, force_push, get_commits, get_repos, merge_branch, normalize_repo_id, RepoId, spotless_apply, unclone_repo } from "./requests/repos";
import { delete_dev, DevBranchStatus, get_dev_branch_status } from "./requests/branches";
import { get_prs as get_mergeable_prs, NOT_REVERTABLE, stringify_pr, PRInfo, PullRequest } from "./requests/prs";
import yaml from "yaml";
import { dev_branch, dev_custom, dev_error, dryrun, logger, repos } from "./env";

async function needs_update(repo_id: RepoId, prs: PRInfo, default_branch: string) {
    const dev_update = _.get(await get_commits(repo_id, `${dev_branch} -n 1`), [0, "committer_date"], null);
    const dev_custom_update = _.get(await get_commits(repo_id, `${dev_custom} -n 1`), [0, "committer_date"], null);

    if (prs.prs.length == 0 && !dev_custom_update) {
        if (dev_update) {
            logger.info(`No experimental changes are available for this repository: deleting the ${dev_branch} branch`);
            if (!dryrun) await delete_dev(repo_id);
            logger.info(`Deleted ${dev_branch} branch`);
            return false;
        }

        logger.info(`No experimental changes are available for this repository and this repository doesn't have a ${dev_custom} branch: skipping it`);
        return false;
    }

    if (dev_update) {
        const commits = await get_commits(repo_id, `${dev_branch} -n 5`);

        const status = get_dev_branch_status(commits);

        var needs_update = false;

        if (status) {
            const permalinks = _.map(prs.prs, "permalink");

            const added = _.difference(status["Included PRs"], permalinks);
            const removed = _.difference(permalinks, status["Included PRs"]);

            if (!_.isEmpty(added)) {
                logger.info(`Detected new PRs: ${added.join(", ")}`);
                needs_update = true;
            }

            if (!_.isEmpty(removed)) {
                logger.info(`Detected merged or closed PRs: ${removed.join(", ")}`);
                needs_update = true;
            }
        }

        const commits_to_master = await get_commits(repo_id, `${dev_branch}..${default_branch}`);

        logger.info(`There have been ${commits_to_master.length} commits to ${default_branch} since ${dev_branch} was last updated`);

        if (commits_to_master.length > 0) {
            needs_update = true;
        }

        for (const pr of prs.prs) {
            const lastUpdate = new Date(pr.updatedAt);
            if (lastUpdate > dev_update) {
                needs_update = true;
                logger.info(`Detected changes in https://github.com/${repo_id}/pull/${pr.number} (last updated at ${lastUpdate})`);
            }
        }

        if (dev_custom_update && dev_update < dev_custom_update) {
            logger.info(`Detected changes in the ${dev_custom} branch (last updated at ${dev_custom_update})`);
        }

        if (!needs_update) {
            logger.info(`No PRs have been updated: ${dev_branch} will not be updated`);

            return false;
        }
    }

    return true;
}

async function merge_prs_into_dev(repo_id: RepoId) {
    await unclone_repo(repo_id);

    logger.info(`Checking for changes in https://github.com/${repo_id}`);

    try {
        const { default_branch } = await clone_repo(repo_id);

        if (await checkout_branch(repo_id, dev_branch)) {
            await checkout_branch(repo_id, "-");
        }
    
        const prs = await get_mergeable_prs(repo_id, default_branch);

        logger.info(`${repo_id} has ${prs.prs.length} PR(s) ready for testing`);

        if (!await needs_update(repo_id, prs, default_branch)) {
            return;
        }

        const previously_included_prs: string[] = [];
    
        if (await checkout_branch(repo_id, dev_branch)) {
            const status = get_dev_branch_status(await get_commits(repo_id, `${dev_branch} -n 5`));

            if (status) {
                status["Included PRs"].forEach(x => previously_included_prs.push(x));
            }
        }
    
        await checkout_branch(repo_id, default_branch);
    
        await delete_branch(repo_id, dev_branch);
        await checkout_new_branch(repo_id, dev_branch);
    
        logger.info(`Merging ${prs.prs.length} PRs`);
    
        const merged: PullRequest[] = [];

        for (const pr of prs.prs) {
            logger.info(`Checking out ${pr.permalink}`);
        
            await checkout_pr(repo_id, pr.permalink);
    
            await checkout_branch(repo_id, dev_branch);
    
            try {
                logger.info(`Merging ${pr.permalink}`);
            
                await merge_branch(repo_id, "-", `Merge '${pr.title}' into ${dev_branch}`);
                merged.push(pr);
            } catch (e) {
                logger.error(`Could not merge ${pr.permalink} into ${dev_branch}: ${e}`);
                await abort_merge(repo_id);
    
                if (_.includes(pr.labels, NOT_REVERTABLE) && _.includes(previously_included_prs, pr.permalink)) {
                    logger.error(`Experimental tagging will be cancelled since non-revertable PR ${pr.permalink} could not be merged into ${dev_branch}: the ${dev_branch} branch prior to this merge will be pushed to ${dev_error}`);
                    if (!dryrun) await force_push(repo_id, `${dev_error}`);
                    throw new Error(`Could not merge non-revertable PR into ${dev_branch}`);
                }
            }
        }
    
        logger.info(`Checking out ${dev_custom}`);
        
        if (await checkout_branch(repo_id, dev_custom)) {
            await checkout_branch(repo_id, dev_branch);
    
            try {
                logger.info(`Merging ${dev_custom}`);
            
                await merge_branch(repo_id, "-");
            } catch (e) {
                logger.error(`Could not merge ${dev_custom} into ${dev_branch}: ${e}`);

                logger.error(`Experimental tagging will be cancelled since ${dev_custom} could not be merged into ${dev_branch}: the ${dev_branch} branch prior to this merge will be pushed to ${dev_error}`);
                if (!dryrun) await force_push(repo_id, `${dev_error}`);
                throw new Error(`Could not merge ${dev_custom} into ${dev_branch}`);
            }
        } else {
            logger.info(`${dev_custom} does not exist: it will not be merged into ${dev_branch}`);
        }

        await spotless_apply(repo_id);

        const state: DevBranchStatus = {
            "Included PRs": _.map(merged, "permalink"),
            "Removed PRs": _.difference(previously_included_prs, _.map(merged, "permalink")),
            "Dependencies": _.map(prs.dependencies, stringify_pr),
        };

        // Scramble the commit message with base64 to prevent github from spamming PRs with links to these commits
        await commit(repo_id, "Dev Branch Status", Buffer.from(yaml.stringify(state)).toString('base64'));

        if (!dryrun) await force_push(repo_id, dev_branch);
    } finally {
        if (!dryrun) await unclone_repo(repo_id);
    }
}

const repo_ids = repos.length === 0 ? await get_repos() : _.map(repos, normalize_repo_id);

logger.debug(`Updating repos: ${repo_ids.map(x => `"${x}"`).join(", ")}`);

logger.info(`Updating ${repo_ids.length} repos`);

for (const repo_id of repo_ids) {
    await merge_prs_into_dev(repo_id);
}
