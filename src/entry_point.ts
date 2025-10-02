import _ from "lodash";
import { get_members } from "./requests/teams";
import { checkout_branch, checkout_new_branch, checkout_pr, clone_repo, commit, delete_branch, force_push, get_commits, get_repos, merge_branch, normalize_repo_id, push, spotless_apply, stringify_repo_id, unclone_repo, update_repo } from "./requests/repos";
import { Logger, pino } from "pino";
import { delete_dev, DevBranchStatus, get_branch_commits, get_branch_update_time, get_dev_branch_status } from "./requests/branches";
import { get_pr, get_prs, NOT_REVERTABLE, parse_pr, PRId, stringify_pr } from "./requests/prs";
import yaml from "yaml";
import { prod } from "./env";
import { DepGraph } from "dependency-graph";
import { create_tag, get_latest_tag, get_latest_tags, get_tag_for_ref, increment_tag, ParsedTag, stringify_tag, wait_for_action } from "./requests/tags";

export const logger: Logger = prod ? pino({ level: "warn" }) : pino({ transport: { target: "pino-pretty", options: { colorize: true, }, }, level: "debug", });

export const dryrun: boolean = true;

// const members = await get_members();

const repo_ids = ["GTNewHorizons/MergeMasterXXL-TestRepo", "GTNewHorizons/MergeMasterXXL-TestRepo-2"]; // await get_repos();

const includedPRs: {[repo:string]: PRId[]} = {};
const dependencies: {[repo:string]: PRId[]} = {};

for (const rid of repo_ids) {
    const repo_id = normalize_repo_id(rid);

    logger.info(`Checking for changes in https://github.com/${repo_id}`);

    const prs = await get_prs(repo_id);

    logger.info(`${repo_id} has ${prs.prs.length} PR(s) ready for testing`);

    const dev_update = await get_branch_update_time(repo_id, "dev");
    const dev_custom = await get_branch_update_time(repo_id, "dev-custom");

    if (!dev_update && prs.prs.length == 0 && !dev_custom) {
        logger.info("No experimental changes are available for this repository and this repository doesn't have a dev branch: skipping it");
        continue;
    }

    if (dev_update) {
        if (prs.prs.length == 0 && !dev_custom) {
            logger.info("No experimental changes are available for this repository: deleting the dev branch");
            await delete_dev(repo_id);
            logger.info("Deleted dev branch");
            continue;
        }

        var needs_update = false;

        for (const pr of prs.prs) {
            const lastUpdate = new Date(pr.updatedAt);
            if (lastUpdate > dev_update) {
                needs_update = true;
                logger.info(`Detected changes in https://github.com/${repo_id}/pull/${pr.number} (last updated at ${lastUpdate})`);
            }
        }

        if (dev_custom && dev_update < dev_custom) {
            logger.info(`Detected changes in the dev-custom branch (last updated at ${dev_custom})`);
        }

        if (!needs_update) {
            logger.info("No PRs have been updated: dev will not be updated");

            const commits = await get_branch_commits(repo_id, "dev");

            const status = get_dev_branch_status(commits);

            if (status) {
                includedPRs[repo_id] = _.map(status["Included PRs"], pr => parse_pr(pr) as PRId);
                dependencies[repo_id] = _(status["Dependencies"]).map(parse_pr).filter(Boolean).value() as PRId[];
            }
            
            continue;
        }
    }

    try {
        await clone_repo(repo_id);
    
        const previously_included_prs: string[] = [];
    
        if (await checkout_branch(repo_id, "dev")) {
            const status = get_dev_branch_status(await get_commits(repo_id, "dev -n 5"));

            if (status) {
                status["Included PRs"].forEach(x => previously_included_prs.push(x));
            }
        }
    
        await checkout_branch(repo_id, "master");
    
        await delete_branch(repo_id, "dev");
        await checkout_new_branch(repo_id, "dev");
    
        logger.info(`Merging ${prs.prs.length} PRs`);
    
        for (const pr of prs.prs) {
            logger.info(`Checking out ${pr.permalink}`);
        
            await checkout_pr(repo_id, pr.permalink);
    
            await checkout_branch(repo_id, "dev");
    
            try {
                logger.info(`Merging ${pr.permalink}`);
            
                await merge_branch(repo_id, "-");
            } catch (e) {
                logger.error(`Could not merge ${pr.permalink} into dev: ${e}`);
    
                if (_.find(pr.labels.nodes, { name: NOT_REVERTABLE })) {
                    if (_.includes(previously_included_prs, pr.permalink)) {
                        logger.error(`Experimental tagging will be cancelled since non-revertable PR ${pr.permalink} could not be merged into dev: the dev branch prior to this merge will be pushed to dev-error`);
                        await force_push(repo_id, "dev-error");
                        throw new Error("Could not merge non-revertable PR into dev");
                    }
                }
            }
        }
    
        logger.info(`Checking out dev-custom`);
        
        if (await checkout_branch(repo_id, "dev-custom")) {
            await checkout_branch(repo_id, "dev");
    
            try {
                logger.info(`Merging dev-custom`);
            
                await merge_branch(repo_id, "-");
            } catch (e) {
                logger.error(`Could not merge dev-custom into dev: ${e}`);

                logger.error(`Experimental tagging will be cancelled since dev-custom could not be merged into dev: the dev branch prior to this merge will be pushed to dev-error`);
                await force_push(repo_id, "dev-error");
                throw new Error("Could not merge dev-custom into dev");
            }
        } else {
            logger.info(`dev-custom does not exist: it will not be merged into dev`);
        }

        await spotless_apply(repo_id);

        const state: DevBranchStatus = {
            "Included PRs": _.map(prs.prs, "permalink"),
            "Removed PRs": _.difference(previously_included_prs, _.map(prs.prs, "permalink")),
            "Dependencies": _.map(prs.dependencies, stringify_pr),
        };

        await commit(repo_id, "Dev Branch Status", yaml.stringify(state));

        await force_push(repo_id, "dev");

        includedPRs[repo_id] = _.map(prs.prs, pr => parse_pr(pr.permalink) as PRId);
        dependencies[repo_id] = prs.dependencies;
    } finally {
        await unclone_repo(repo_id);
    }
}

const allIncludedPRs = new Set(_(includedPRs).values().flatten().map(stringify_pr).value());

const graph = new DepGraph();

for (const repo of repo_ids) {
    graph.addNode(repo);
}

var success = true;

for (const [repo, dep_prs] of _.entries(dependencies)) {
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

for (const repo_id of graph.overallOrder()) {
    try {
        logger.info(`Creating releases for ${repo_id}`);

        await clone_repo(repo_id);

        const latestTag = _.maxBy(await get_latest_tags(repo_id), "values") as ParsedTag;

        const latestMaster = await get_latest_tag(repo_id, "master");
        const commitsToMaster = await get_commits(repo_id, `${stringify_tag(latestMaster)}..master`);

        if (commitsToMaster.length > 0) {
            const tag_name = increment_tag(latestTag, false);
            master_tags[repo_id] = tag_name;
            pre_tags[repo_id] = tag_name;

            logger.info(`Creating tag ${tag_name} off of master branch (repo: ${repo_id})`);

            await update_repo(repo_id, master_tags);
            await push(repo_id, "master");

            const workflow_sha = await create_tag(repo_id, tag_name, "master");
            
            logger.info(`Created and pushed ${tag_name} (base branch: master,repo: ${repo_id}, workflow commit: ${workflow_sha})`);

            if (workflow_sha) {
                workflows[repo_id] = workflow_sha;
            }
        } else {
            logger.info(`No commits have been made to master since ${stringify_tag(latestMaster)}: another tag will not be created`);
        }

        if (await checkout_branch(repo_id, "dev")) {
            if (await get_tag_for_ref(repo_id, "dev")) {
                logger.info(`dev branch for ${repo_id} already has a tag: it will not be tagged again because it has not been updated`)
            } else {
                const tag_name = increment_tag(latestTag, true);
                pre_tags[repo_id] = tag_name;
    
                logger.info(`Creating tag ${tag_name} off of dev branch (repo: ${repo_id})`);
    
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
    
                logger.info(`Actions for all dependencies have finished: tagging dev branch (repo: ${repo_id})`);
    
                await update_repo(repo_id, pre_tags);
                await force_push(repo_id, "dev");
    
                const workflow_sha = await create_tag(repo_id, tag_name, "dev");
    
                logger.info(`Created and pushed ${tag_name} (base branch: dev, repo: ${repo_id}, workflow commit: ${workflow_sha})`);
    
                // Overwrite the master workflow if one exists
                if (workflow_sha) {
                    workflows[repo_id] = workflow_sha;
                }
            }
        }
    } finally {
        await unclone_repo(repo_id);
    }
}
