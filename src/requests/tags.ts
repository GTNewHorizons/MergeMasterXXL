import _ from "lodash";
import { exec, get_repo_path, parse_repo_id, RepoId } from "./repos";
import { octokit } from "./types";
import { logger } from "../env";
import path from "path";
import fs from "fs";
import { wait } from "../mmxxl_utils";
import { sprintf } from "sprintf-js";
import { NEWLINE } from "./prs";

function isDigit(c: string): boolean {
    return c.charCodeAt(0) >= '0'.charCodeAt(0) && c.charCodeAt(0) <= '9'.charCodeAt(0);
}

const PRE = "-pre";

export type ParsedTag = {
    format: string,
    values: number[],
};

export function parse_tag(tag: string): ParsedTag {
    var i = 0;

    var start = 0;
    var wasDigit: boolean | null = null;

    var format = "";
    var values: number[] = [];

    while (i < tag.length) {
        const digit = isDigit(tag.substring(i, i + 1));

        if (wasDigit != digit) {
            const str = tag.substring(start, i);

            if (wasDigit) {
                values.push(parseInt(str));
                format += "%d";
            } else {
                format += str;
            }

            start = i;
            wasDigit = digit;
        }

        i++;
    }

    if (start < i) {
        const str = tag.substring(start, i);

        if (wasDigit) {
            values.push(parseInt(str));
            format += "%d";
        } else {
            format += str;
        }
    }

    return {
        format,
        values
    };
}

export function stringify_tag(tag: ParsedTag): string {
    return sprintf(tag.format, ...tag.values);
}

export function increment_tag(tag: ParsedTag, pre: boolean): string {
    if (tag.format.endsWith(PRE)) {
        tag.format = tag.format.substring(0, tag.format.length - PRE.length);
    }

    if (pre) {
        tag.format += PRE;
    }

    tag.values[tag.values.length - 1]++;

    return stringify_tag(tag);
}

export async function get_latest_tag(repo_id: RepoId, branch: string = "HEAD"): Promise<ParsedTag> {
    const result = await exec(`git describe --abbrev=0 --tags ${branch}`, { cwd: get_repo_path(repo_id) });

    return parse_tag(result.stdout.trim());
}

export async function get_latest_tags(repo_id: RepoId): Promise<ParsedTag[]> {
    try {
        const result = await exec(`git tag -l --sort=creatordate | tail -n 5`, { cwd: get_repo_path(repo_id) });
    
        const lines = _.filter(result.stdout.trim().split(NEWLINE), Boolean);

        return _.map(lines, parse_tag);
    } catch (e) {
        logger.info(`Could not get latest 5 tags for ${repo_id}: ${e}`);
        return [];
    }
}

export async function create_tag(repo_id: RepoId, tag_name: string, base: string = "HEAD") {
    await exec(`git tag -f ${tag_name} ${base}`, { cwd: get_repo_path(repo_id) });
}

export type WorkflowId = number;

export async function push_tag(repo_id: RepoId, tag_name: string, base: string = "HEAD"): Promise<WorkflowId | null> {
    const { owner, repo } = parse_repo_id(repo_id);

    await exec(`git push origin tag ${tag_name}`, { cwd: get_repo_path(repo_id) });

    if (fs.existsSync(path.join(get_repo_path(repo_id), ".github", "workflows", "release-tags.yml"))) {
        const sha = (await exec(`git rev-parse ${base}`, { cwd: get_repo_path(repo_id) })).stdout.trim();

        await wait(1000);

        var tries: number = 0;

        while (true) {
            tries++;

            if (tries > 3) {
                logger.error(`Could not find action run for commit ${sha} after 3 retries: assuming it was cancelled`);
                return null;
            }

            const resp = (await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
                owner,
                repo,
                event: "push",
                head_sha: sha,
                per_page: 1
            })).data;

            const workflow_run = _.find(resp.workflow_runs, { head_branch: tag_name });

            if (!workflow_run) {
                logger.info(`Could not find action run for ${sha}: waiting 10 seconds`);
                
                await wait(10000);

                continue;
            } else {
                logger.info(`Found active action for ${sha}: https://github.com/${owner}/${repo}/actions/runs/${workflow_run.id}`);

                return workflow_run.id;
            }
        }
    } else {
        return null;
    }
}

export type WorkflowStatus = "unknown" | "in-progress" | "failed" | "completed";

export async function get_action_state(repo_id: RepoId, workflow_id: WorkflowId): Promise<WorkflowStatus | null> {
    const { owner, repo } = parse_repo_id(repo_id);

    const workflow = (await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
        owner,
        repo,
        run_id: workflow_id
    })).data;

    if (!workflow) return null;

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

    return workflow.status && lookup[workflow.status] || "unknown";
}

export async function wait_for_action(repo_id: RepoId, ref: string, workflow_id: WorkflowId) {
    const { owner, repo } = parse_repo_id(repo_id);

    const action = await get_action_state(repo_id, workflow_id);

    if (action == "completed") {
        logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${workflow_id} was already finished`);
        return true;
    }

    if (action) {
        logger.info(`Waiting for action https://github.com/${owner}/${repo}/actions/runs/${workflow_id} to finish`);
    } else {
        logger.info(`Waiting for action for ${owner}/${repo}:${ref} to start`);
    }

    logger.info("Sleeping for 2 minutes");
    await wait(1000 * 60 * 2);

    for (var i = 0; i < 6; i++) {
        const workflow_status = await get_action_state(repo_id, workflow_id);
    
        if (workflow_status == "failed") {
            logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${workflow_id} has failed`);
            return false;
        }

        if (workflow_status == "completed") {
            logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${workflow_id} has completed`);
            return false;
        }
    
        logger.info("Sleeping for 1 minute");
        await wait(1000 * 60);
    }

    logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${workflow_id} has timed out`);

    return false;
}

export async function get_tag_for_ref(repo_id: RepoId, ref: string) {
    try {
        const result = await exec(`git describe --tags --exact-match ${ref}`, { cwd: get_repo_path(repo_id) });
    
        return result.stdout.trim();
    } catch (e) {
        logger.info(`Ref ${repo_id}:${ref} was not tagged: ${e}`);
        return null;
    }
}
