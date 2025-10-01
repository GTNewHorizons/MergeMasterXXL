import _ from "lodash";
import { exec, get_repo_path } from "./repos";
import { octokit } from "./types";
import { logger } from "../entry_point";
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

export async function get_latest_tag(repo: string, branch: string = "HEAD"): Promise<ParsedTag> {
    const result = await exec(`git describe --abbrev=0 --tags ${branch}`, { cwd: get_repo_path(repo) });

    return parse_tag(result.stdout.trim());
}

export async function get_latest_tags(repo: string): Promise<ParsedTag[]> {
    try {
        const result = await exec(`git tag -l | tail -n 5`, { cwd: get_repo_path(repo) });
    
        const lines = result.stdout.split(NEWLINE);

        return _.map(lines, parse_tag);
    } catch (e) {
        logger.info(`Could not get latest 5 tags for ${repo}:}: ${e}`);
        return [];
    }
}

export async function create_tag(owner: string, repo: string, tag_name: string, base: string = "HEAD") {
    await exec(`git tag -f ${tag_name} ${base}`, { cwd: get_repo_path(repo) });

    await exec(`git push origin tag ${tag_name}`, { cwd: get_repo_path(repo) });

    if (fs.existsSync(path.join(get_repo_path(repo), ".github", "workflows", "release-tags.yml"))) {
        const sha = (await exec(`git rev-parse ${base}`, { cwd: get_repo_path(repo) })).stdout.trim();

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

            if (resp.total_count == 0) {
                logger.warn(`Could not find action run for ${sha}: waiting 10 seconds`);
                
                await wait(10000);

                continue;
            } else {
                logger.info(`Found active action for ${sha}: https://github.com/${owner}/${repo}/actions/runs/${resp.workflow_runs[0].id}`);

                return sha;
            }
        }
    } else {
        return null;
    }
}

export type Action = {
    state: "unknown" | "in-progress" | "failed" | "completed";
    id: number;
};

export async function get_action_state(owner: string, repo: string, ref: string): Promise<Action | null> {
    const resp = (await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
        owner,
        repo,
        event: "push",
        head_sha: ref,
        per_page: 1
    })).data;

    if (resp.workflow_runs.length == 0) return null;

    const status = resp.workflow_runs[0].status;

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

    return {
        state: status && lookup[status] || "unknown",
        id: resp.workflow_runs[0].id
    };
}

export async function wait_for_action(owner: string, repo: string, ref: string) {
    const action = await get_action_state(owner, repo, ref);

    if (action?.state == "completed") {
        logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${action.id} was already finished`);
        return true;
    }

    if (action) {
        logger.info(`Waiting for action https://github.com/${owner}/${repo}/actions/runs/${action.id} to finish`);
    } else {
        logger.info(`Waiting for action for ${owner}/${repo}:${ref} to start`);
    }

    logger.info("Sleeping for 2 minutes");
    await wait(1000 * 60 * 2);

    for (var i = 0; i < 6; i++) {
        const action = await get_action_state(owner, repo, ref);
    
        if (action && action?.state != "unknown" && action?.state != "in-progress") {
            if (action.state == "completed") {
                return true;
            } else {
                logger.info(`Action https://github.com/${owner}/${repo}/actions/runs/${action.id} failed`);
                return false;
            }
        }
    
        logger.info("Sleeping for 1 minute");
        await wait(1000 * 60);
    }

    return false;
}

export async function get_tag_for_ref(repo: string, ref: string) {
    try {
        const result = await exec(`git describe --tags --exact-match ${ref}`, { cwd: get_repo_path(repo) });
    
        return result.stdout.trim();
    } catch (e) {
        logger.info(`Ref ${repo}:${ref} was not tagged: ${e}`);
        return null;
    }
}
