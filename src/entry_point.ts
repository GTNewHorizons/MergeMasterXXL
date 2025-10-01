import _ from "lodash";
import { get_members } from "./requests/teams";
import { checkout_branch, checkout_new_branch, checkout_pr, clone_repo, commit, delete_branch, force_push, get_commits, get_repos, merge_branch, push, spotless_apply, update_repo } from "./requests/repos";
import { Logger, pino } from "pino";
import { delete_dev, DevBranchStatus, get_branch_commits, get_branch_update_time, get_dev_branch_status } from "./requests/branches";
import { get_pr, get_prs, NOT_REVERTABLE, parse_pr, PRId, stringify_pr } from "./requests/prs";
import yaml from "yaml";
import { prod } from "./env";
import { DepGraph } from "dependency-graph";
import { ActionId, create_tag, get_latest_tag, increment_tag, wait_for_action } from "./requests/tags";

export const logger: Logger = prod ? pino({ level: "warn" }) : pino({ transport: { target: "pino-pretty", options: { colorize: true, }, }, level: "debug", });

export const dryrun: boolean = true;

// const members = await get_members();

const repos = ["MergeMasterXXL-TestRepo"]; // await get_repos();

const graph = new DepGraph();

for (const repo of repos) {
    graph.addNode(repo);
}

const includedPRs: {[repo:string]: PRId[]} = {};
const dependencies: {[repo:string]: PRId[]} = {};

for (const repo of repos) {
    logger.info(`Checking for changes in https://github.com/GTNewHorizons/${repo}`);

    const prs = await get_prs(repo);

    logger.info(`${repo} has ${prs.prs.length} PR(s) ready for testing`);

    const dev_update = await get_branch_update_time(repo, "dev");
    const dev_custom = await get_branch_update_time(repo, "dev-custom");

    await get_branch_commits(repo, "dev");

    if (!dev_update && prs.prs.length == 0 && !dev_custom) {
        logger.info("No experimental changes are available for this repository and this repository doesn't have a dev branch: skipping it");
        continue;
    }

    if (dev_update) {
        if (prs.prs.length == 0 && !dev_custom) {
            logger.info("No experimental changes are available for this repository: deleting the dev branch");
            await delete_dev(repo);
            logger.info("Deleted dev branch");
            continue;
        }

        var needs_update = false;

        for (const pr of prs.prs) {
            const lastUpdate = new Date(pr.updatedAt);
            if (lastUpdate > dev_update) {
                needs_update = true;
                logger.info(`Detected changes in https://github.com/GTNewHorizons/${repo}/pull/${pr.number} (last updated at ${lastUpdate})`);
            }
        }

        if (dev_custom && dev_update < dev_custom) {
            logger.info(`Detected changes in the dev-custom branch (last updated at ${dev_custom})`);
        }

        if (!needs_update) {
            logger.info("No PRs have been updated: dev will not be updated");

            const status = get_dev_branch_status(await get_branch_commits(repo, "dev"));

            if (status) {
                includedPRs[repo] = _.map(status["Included PRs"], pr => parse_pr(pr) as PRId);
            }
            
            continue;
        }
    }

    try {
        await clone_repo(repo);
    
        const previously_included_prs: string[] = [];
    
        if (await checkout_branch(repo, "dev")) {
            const status = get_dev_branch_status(await get_commits(repo, "dev -n 5"));

            if (status) {
                status["Included PRs"].forEach(x => previously_included_prs.push(x));
            }
        }
    
        await checkout_branch(repo, "master");
    
        await delete_branch(repo, "dev");
        await checkout_new_branch(repo, "dev");
    
        logger.info(`Merging ${prs.prs.length} PRs`);
    
        for (const pr of prs.prs) {
            logger.info(`Checking out ${pr.permalink}`);
        
            await checkout_pr(repo, pr.permalink);
    
            await checkout_branch(repo, "dev");
    
            try {
                logger.info(`Merging ${pr.permalink}`);
            
                await merge_branch(repo, "-");
            } catch (e) {
                logger.error(`Could not merge ${pr.permalink} into dev: ${e}`);
    
                if (_.find(pr.labels.nodes, { name: NOT_REVERTABLE })) {
                    if (_.includes(previously_included_prs, pr.permalink)) {
                        logger.error(`Experimental tagging will be cancelled since ${pr.permalink} could not be merged into dev: the dev branch prior to this merge will be pushed to dev-error`);
                        await force_push(repo, "dev-error");
                        break;
                    }
                }
            }
        }
    
        logger.info(`Checking out dev-custom`);
        
        if (await checkout_branch(repo, "dev-custom")) {
            await checkout_branch(repo, "dev");
    
            try {
                logger.info(`Merging dev-custom`);
            
                await merge_branch(repo, "-");
            } catch (e) {
                logger.error(`Could not merge dev-custom into dev: ${e}`);

                logger.error(`Experimental tagging will be cancelled since dev-custom could not be merged into dev: the dev branch prior to this merge will be pushed to dev-error`);
                await force_push(repo, "dev-error");
                break;
            }
        } else {
            logger.info(`dev-custom does not exist: it will not be merged into dev`);
        }

        const state: DevBranchStatus = {
            "Included PRs": _.map(prs.prs, "permalink"),
            "Removed PRs": _.difference(previously_included_prs, _.map(prs.prs, "permalink")),
            "Dependencies": _.map(prs.dependencies, stringify_pr),
        };

        await spotless_apply(repo);

        await commit(repo, "Dev Branch Status", yaml.stringify(state));

        await force_push(repo, "dev");

        includedPRs[repo] = _.map(prs.prs, pr => parse_pr(pr.permalink) as PRId);
        dependencies[repo] = prs.dependencies;

        for (const dep of prs.dependencies) {
            if (graph.hasNode(dep.repo)) {
                graph.addDependency(repo, dep.repo);
            } else {
                logger.warn(`Ignoring invalid repo depencency for ${repo}: ${dep.repo}`);
            }
        }
    } finally {
        // delete cloned repo
    }
}

const allIncludedPRs = new Set(_(includedPRs).values().flatten().map(stringify_pr).value());

var success = true;

for (const [repo, deps] of _.entries(dependencies)) {
    for (const dep of deps) {
        if (!allIncludedPRs.has(stringify_pr(dep))) {
            const pr = await get_pr(dep);

            if (!pr) {
                logger.error(`Repo ${repo} requires PR ${stringify_pr(dep)}, which does not exist`);
                success = false;
                continue;
            }

            if (pr && pr.merged) {
                allIncludedPRs.add(stringify_pr(dep));
                continue;
            }

            logger.error(`Repo ${repo} requires PR ${dep}, which was not included in the build: this experimental will be cancelled, this cannot be automatically recovered from`);
            success = false;
        }
    }
}

if (!success) {
    throw new Error("PR dependency check failed");
}

const taggedRepos = new Set();

const workflows: {[repo: string]: ActionId} = {};

for (const repo of graph.overallOrder()) {
    try {
        await clone_repo(repo);

        const latestMaster = await get_latest_tag(repo, "master");

        var tag = latestMaster;

        const commitsToMaster = await get_commits(repo, `${latestMaster}..master`);

        if (commitsToMaster.length > 0) {
            tag = increment_tag(tag, false);

            logger.info(`Creating tag ${tag} for master (repo: ${repo})`);

            await update_repo(repo);
            await push(repo, "master");

            const workflow_id = await create_tag("GTNewHorizons", repo, tag, "master");
            
            logger.info(`Created and pushed ${tag} for master (repo: ${repo}, workflow: ${workflow_id})`);

            if (workflow_id) workflows[repo] = workflow_id;
        } else {
            logger.info(`No commits have been made to master since ${tag}: another tag will not be created`);
        }

        if (await checkout_branch(repo, "dev")) {
            tag = increment_tag(tag, true);

            logger.info(`Creating tag ${tag} for dev (repo: ${repo})`);

            for (const dep of graph.dependenciesOf(repo)) {
                const workflow = workflows[dep];

                if (workflow) {
                    await wait_for_action("GTNewHorizons", dep, workflow);
                }
            }

            logger.info(`Actions for all dependencies have finished: tagging dev branch (repo: ${repo})`);

            await update_repo(repo);
            await push(repo, "dev");

            const workflow_id = await create_tag("GTNewHorizons", repo, tag, "dev");

            logger.info(`Created and pushed ${tag} for dev (repo: ${repo}, workflow: ${workflow_id})`);

            // Overwrite the master workflow
            if (workflow_id) workflows[repo] = workflow_id;
        }
    } finally {
        // delete repo
    }
}
