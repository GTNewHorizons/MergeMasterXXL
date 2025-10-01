import _ from "lodash";
import { exec, get_repo_path } from "./repos";
import { octokit } from "./types";
import { logger } from "../entry_point";
import path from "path";
import fs from "fs";
import { wait } from "../mmxxl_utils";

function isDigit(c: string): boolean {
    return c.charCodeAt(0) >= '0'.charCodeAt(0) && c.charCodeAt(0) <= '9'.charCodeAt(0);
}

const PRE = "-pre";

export function increment_tag(tag: string, pre: boolean): string {
    if (tag.endsWith(PRE)) {
        tag = tag.substring(0, tag.length - PRE.length);
    }

    var end = _.findLastIndex(tag, isDigit);
    var start = _.findLastIndex(tag, x => !isDigit(x), end);

    start++;
    end++;

    var version = parseInt(tag.substring(start, end));

    version++;

    var newTag = tag.substring(0, start) + version + tag.substring(end);

    if (pre) {
        newTag += PRE;
    }

    return newTag;
}

export async function get_latest_tag(repo: string, branch: string = "HEAD"): Promise<string> {
    const result = await exec(`git describe --abbrev=0 --tags ${branch}`, { cwd: get_repo_path(repo) });

    return result.stdout.trim();
}

export type ActionId = number;

export async function create_tag(owner: string, repo: string, tag_name: string, base: string = "HEAD"): Promise<ActionId | null> {
    await exec(`git tag -f ${tag_name} ${base}`, { cwd: get_repo_path(repo) });

    await exec(`git push origin tag ${tag_name}`, { cwd: get_repo_path(repo) });

    if (fs.existsSync(path.join(get_repo_path(repo), ".github", "workflows", "release-tags.yml"))) {
        const sha = (await exec(`git rev-parse ${base}`, { cwd: get_repo_path(repo) })).stdout.trim();

        await wait(1000);

        var check_suite_id: number | undefined, tries: number = 0;

        do {
            tries++;

            if (tries > 3) {
                logger.error(`Could not find action run for ${sha} after 3 retries: assuming it was cancelled`);
                return null;
            }

            const resp = (await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
                owner,
                repo,
                event: "push",
                head_sha: sha
            })).data;

            if (resp.total_count == 0) {
                logger.warn(`Could not find action run for ${sha}: waiting 10 seconds`);
                
                await wait(10000);

                continue;
            } else {
                check_suite_id = resp.workflow_runs[0].check_suite_id;
            }
        } while (!check_suite_id);

        return check_suite_id;
    } else {
        return null;
    }
}

export async function get_action_state(owner: string, repo: string, run_id: ActionId): Promise<"unknown" | "in-progress" | "failed" | "completed"> {
    try {
        const resp = (await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
            owner,
            repo,
            run_id
        })).data;
    
        const status = resp.status;

        const lookup = {
            "completed" : "completed",
            "action_required" : "unknown",
            "cancelled" : "failed",
            "failure" : "failed",
            "neutral": "failed",
            "skipped": "failed",
            "stale": "failed",
            "success" : "completed",
            "timed_out" : "failed",
            "in_progress" : "in-progess",
            "queued" : "in-progess",
            "requested" : "in-progess",
            "waiting" : "in-progess",
            "pending" : "in-progess",
        };

        return status && lookup[status] || "unknown";
    } catch (e) {
        logger.error(`Could not find action https://github.com/${owner}/${repo}/actions/runs/${run_id}: ${e}`);
        return "failed";
    }
}

export async function wait_for_action(owner: string, repo: string, run_id: ActionId) {
    const state = await get_action_state(owner, repo, run_id);

    if (state == "completed") return true;

    logger.info(`Waiting for action https://github.com/${owner}/${repo}/actions/runs/${run_id} to finish`);

    await wait(1000 * 60 * 2);

    for (var i = 0; i < 6; i++) {
        const state = await get_action_state(owner, repo, run_id);
    
        if (state != "unknown" && state != "in-progress") return state == "completed";
    
        await wait(1000 * 60);
    }

    return false;
}
