import _ from "lodash";
import { abort_merge, checkout_branch, checkout_new_branch, checkout_pr, clone_repo, commit, delete_branch, force_push, get_commits, merge_branch, RepoId, spotless_apply, stringify_repo_id, unclone_repo, update_repo } from "./requests/repos";
import { Logger, pino } from "pino";
import { delete_dev, DevBranchStatus, get_dev_branch_status } from "./requests/branches";
import { get_pr, get_prs as get_mergeable_prs, NOT_REVERTABLE, parse_pr, PRId, stringify_pr, PRInfo, get_merged_prs, PullRequest } from "./requests/prs";
import yaml from "yaml";
import { dev_branch, dev_custom, dev_error, prod } from "./env";
import { DepGraph } from "dependency-graph";
import { push_tag, get_latest_tag, get_latest_tags, get_tag_for_ref, increment_tag, ParsedTag, stringify_tag, wait_for_action, create_tag } from "./requests/tags";

export const logger: Logger = prod ? pino({ level: "warn" }) : pino({ transport: { target: "pino-pretty", options: { colorize: true, }, }, level: "debug", });

export const dryrun: boolean = true;

const repo_ids = ["GTNewHorizons/GTNHLib"]; // await get_repos_with_prs();

const includedPRs: {[repo:string]: PRId[]} = {};
const masterDependencies: {[repo:string]: PRId[]} = {};
const devDependencies: {[repo:string]: PRId[]} = {};

async function needs_update(repo_id: RepoId, prs: PRInfo) {
    const dev_update = _.get(await get_commits(repo_id, `${dev_branch} -n 1`), [0, "committer_date"], null);
    const dev_custom_update = _.get(await get_commits(repo_id, `${dev_custom} -n 1`), [0, "committer_date"], null);

    if (!dev_update && prs.prs.length == 0 && !dev_custom_update) {
        logger.info(`No experimental changes are available for this repository and this repository doesn't have a ${dev_custom} branch: skipping it`);
        return false;
    }

    if (dev_update) {
        if (prs.prs.length == 0 && !dev_custom_update) {
            logger.info(`No experimental changes are available for this repository: deleting the ${dev_branch} branch`);
            if (!dryrun) await delete_dev(repo_id);
            logger.info(`Deleted ${dev_branch} branch`);
            return false;
        }

        const commits = await get_commits(repo_id, `${dev_branch} -n 5`);

        const status = get_dev_branch_status(commits);

        var needs_update = false;

        if (status) {
            includedPRs[repo_id] = _.map(status["Included PRs"], pr => parse_pr(pr) as PRId);
            devDependencies[repo_id] = _(status["Dependencies"]).map(parse_pr).filter(Boolean).value() as PRId[];

            if (!_.isEqual(status["Included PRs"], prs.prs)) {
                needs_update = true;
            }
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

async function check_merged_prs(repo_id: RepoId, default_branch: string) {
    await checkout_branch(repo_id, default_branch);

    const latest_master = await get_latest_tag(repo_id);
    const commits_since_master_tag = await get_commits(repo_id, `${stringify_tag(latest_master)}..HEAD`);

    if (commits_since_master_tag.length === 0) return;
    console.log("commits_since_master_tag: ", yaml.stringify(commits_since_master_tag));
    
    const merge_commits = new Set(_(commits_since_master_tag)
        .map("prid")
        .filter(Boolean)
        .map(x => x as number)
        .value());

    const merged_prs = await get_merged_prs(repo_id, default_branch, merge_commits, _.toInteger(commits_since_master_tag.length * 1.5));
    console.log("merged_prs: ", yaml.stringify(merged_prs));
}

for (const repo_id of repo_ids) {
    await unclone_repo(repo_id);

    logger.info(`Checking for changes in https://github.com/${repo_id}`);

    try {
        const { default_branch } = await clone_repo(repo_id);
    
        const prs = await get_mergeable_prs(repo_id, default_branch);

        logger.info(`${repo_id} has ${prs.prs.length} PR(s) ready for testing`);

        if (!await needs_update(repo_id, prs)) {
            continue;
        }

        await check_merged_prs(repo_id, default_branch);

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

        await commit(repo_id, "Dev Branch Status", yaml.stringify(state));

        if (!dryrun) await force_push(repo_id, dev_branch);

        includedPRs[repo_id] = _.map(prs.prs, pr => parse_pr(pr.permalink) as PRId);
        devDependencies[repo_id] = prs.dependencies;
    } finally {
        if (!dryrun) await unclone_repo(repo_id);
    }
}

const allIncludedPRs = new Set(_(includedPRs).values().flatten().map(stringify_pr).value());

const graph = new DepGraph();

for (const repo of repo_ids) {
    graph.addNode(repo);
}

var success = true;

for (const [repo, dep_prs] of _.entries(devDependencies)) {
    for (const dep_pr of dep_prs) {
        const repo_id = stringify_repo_id(dep_pr.repo_id);

        if (graph.hasNode(repo_id)) {
            graph.addDependency(repo, repo_id);
        } else {
            logger.warn(`Ignoring invalid depencency for ${repo}: ${repo_id}`);
        }

        if (!allIncludedPRs.has(stringify_pr(dep_pr))) {
            const pr = await get_pr(dep_pr);

            if (!pr) {
                logger.error(`Repo ${repo} requires PR ${stringify_pr(dep_pr)}, which does not exist`);
                success = false;
                continue;
            }

            if (pr.merged) {
                allIncludedPRs.add(stringify_pr(dep_pr));
                continue;
            }

            logger.error(`Repo ${repo} requires PR ${stringify_pr(dep_pr)}, which was not included in the build: this experimental will be cancelled as this cannot be automatically recovered from`);
            success = false;
        }
    }
}

if (!success) {
    throw new Error("PR dependency check failed");
}

const workflows: {[repo: string]: string} = {};

const master_tags: {[repo: string]: string} = {};
const pre_tags: {[repo: string]: string} = {};

function compare_tag_versions(a: ParsedTag, b: ParsedTag): number {
    for (const [l, r] of _.zip(a.values, b.values)) {
        if (l === undefined || r === undefined) {
            if (l === undefined && r == undefined) {
                return 0;
            }

            return l === undefined ? -1 : 1;
        }

        if (l == r) continue;

        return l < r ? -1 : 1;
    }

    return 0;
}

for (const repo_id of graph.overallOrder()) {
    try {
        logger.info(`Creating releases for ${repo_id}`);

        await clone_repo(repo_id);

        const latestTags = await get_latest_tags(repo_id);
        latestTags.sort(compare_tag_versions);

        const latestTag = _.last(latestTags) as ParsedTag;

        if (await checkout_branch(repo_id, dev_branch)) {
            if (await get_tag_for_ref(repo_id, dev_branch)) {
                logger.info(`${dev_branch} branch for ${repo_id} already has a tag: it will not be tagged again because it has not been updated`)
            } else {
                const tag_name = increment_tag(latestTag, true);
                pre_tags[repo_id] = tag_name;
    
                logger.info(`Creating tag ${tag_name} off of ${dev_branch} branch (repo: ${repo_id})`);
    
                for (const dep_repo_id of graph.dependenciesOf(repo_id)) {
                    logger.info(`Checking dependency ${dep_repo_id} (repo: ${repo_id})`);
    
                    const workflow = workflows[dep_repo_id];
    
                    if (workflow) {
                        if (!await wait_for_action(dep_repo_id, workflow)) {
                            logger.info(`Actions for repo ${dep_repo_id} failed: cannot build ${repo_id}, this experimental will be cancelled`);
                            throw new Error("Could not build dependency");
                        }
                    } else {
                        logger.info(`Dependency ${dep_repo_id} did not have a corresponding workflow`);
                    }
                }
    
                logger.info(`Actions for all dependencies have finished: tagging ${dev_branch} branch (repo: ${repo_id})`);
    
                await update_repo(repo_id, pre_tags);
                if (!dryrun) await force_push(repo_id, dev_branch);
    
                await create_tag(repo_id, tag_name, dev_branch);

                if (!dryrun) {
                    const workflow_sha = await push_tag(repo_id, tag_name, dev_branch);
        
                    logger.info(`Created and pushed ${tag_name} (base branch: ${dev_branch}, repo: ${repo_id}, workflow commit: ${workflow_sha})`);
        
                    // Overwrite the default branch's workflow if one exists
                    if (workflow_sha) {
                        workflows[repo_id] = workflow_sha;
                    }
                } else {
                    logger.info(`Created ${tag_name} (base branch: ${dev_branch}, repo: ${repo_id})`);
                }
            }
        }
    } finally {
        if (!dryrun) await unclone_repo(repo_id);
    }
}
