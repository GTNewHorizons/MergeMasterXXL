import _ from "lodash";
import { get_members } from "./requests/teams";
import { checkout_branch, checkout_new_branch, checkout_pr, clone_repo, commit, delete_branch, force_push, get_commits, get_repos, merge_branch } from "./requests/repos";
import { Logger, pino } from "pino";
import { delete_dev, get_branch_update_time } from "./requests/branches";
import { get_prs, NOT_REVERTABLE } from "./requests/prs";
import yaml from "yaml";
import { prod } from "./env";

export const logger: Logger = prod ? pino({ level: "warn" }) : pino({ transport: { target: "pino-pretty", options: { colorize: true, }, }, level: "debug", });

export const dryrun: boolean = true;

// const members = await get_members();

const repos = ["MergeMasterXXL-TestRepo"]; // await get_repos();

type DevBranchStatus = {
    ["Included PRs"]: string[];
};

for (const repo of repos) {
    logger.info(`Checking for changes in https://github.com/GTNewHorizons/${repo}`);

    const prs = await get_prs(repo);

    // const dev_update = await get_branch_update_time(repo, "dev");
    // const dev_manual_update = await get_branch_update_time(repo, "dev-manual");

    // if (!dev_update && prs.prs.length == 0 && !dev_manual_update) {
    //     logger.info("No experimental changes are available for this repository and this repository doesn't have a dev branch: skipping it");
    //     continue;
    // }

    // if (dev_update) {
    //     if (prs.prs.length == 0 && !dev_manual_update) {
    //         logger.info("No experimental changes are available for this repository: deleting the dev branch");
    //         await delete_dev(repo);
    //         logger.info("Deleted dev branch");
    //         continue;
    //     }

    //     var needs_update = false;

    //     for (const pr of prs.prs) {
    //         const lastUpdate = new Date(pr.updatedAt);
    //         if (lastUpdate > dev_update) {
    //             needs_update = true;
    //             logger.info(`Detected changes in https://github.com/GTNewHorizons/${repo}/pull/${pr.number} (last updated at ${lastUpdate})`);
    //         }
    //     }

    //     if (dev_manual_update && dev_update < dev_manual_update) {
    //         logger.info(`Detected changes in the dev-manual branch (last updated at ${dev_manual_update})`);
    //     }

    //     if (!needs_update) {
    //         logger.info("No PRs have been updated: dev will not be updated");
    //         continue;
    //     }
    // }

    try {
        await clone_repo(repo);
    
        const previously_included_prs: string[] = [];
    
        if (await checkout_branch(repo, "dev")) {
            const metadata_commit = (await get_commits(repo, "dev -n 1"))[0];
    
            if (metadata_commit && metadata_commit.committer_name == "MergeMasterXXL" && metadata_commit.subject == "Dev Branch Status") {
                const dev_branch_status: DevBranchStatus = yaml.parse(metadata_commit.message);
    
                dev_branch_status["Included PRs"].forEach(x => previously_included_prs.push(x));
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
                    if (_.find(previously_included_prs, pr.permalink)) {
                        logger.error(`Experimental tagging for ${repo} will be cancelled as ${pr.permalink} could not be merged into it`);
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
                logger.error(`Experimental tagging for ${repo} will be cancelled as a required branch could not be merged into it`);
                break;
            }
        } else {
            logger.info(`dev-custom does not exist: it will not be merged into dev`);
        }

        const state: DevBranchStatus = {
            "Included PRs": _.map(prs.prs, "permalink")
        };

        await commit(repo, "Dev Branch Status", yaml.stringify(state));

        // await force_push(repo, "dev");

    } finally {
        // delete cloned repo
    }
}
