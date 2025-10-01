import _ from "lodash";
import { octokit } from "./types";

import { request } from "@octokit/request";
import axios from "axios";
import path from "path";
import child_process from "child_process";
import { promisify } from "util";
import { logger } from "../entry_point";
import { clone_scratchpad } from "../env";
import fs from "fs";

const exec0 = promisify(child_process.exec);
export const exec: typeof exec0 = function(...args: any[]) {
    logger.info(`Executing: ${arguments[0]}`);
    return (exec0 as any)(...args);
};

const repo_blacklist = [
    
];

export async function get_repos(): Promise<string[]> {
    const data = await axios.get("https://raw.githubusercontent.com/GTNewHorizons/DreamAssemblerXXL/refs/heads/master/releases/manifests/experimental.json");

    const repos = _.keys(data.data.github_mods);

    _.remove(repos, repo => _.find(repo_blacklist, repo));

    return repos;
}

export function get_repo_path(repo: string) {
    return path.join(clone_scratchpad, repo);
}

export async function clone_repo(repo: string, owner: string = "GTNewHorizons"): Promise<void> {
    // await exec(`git clone git@github.com:${owner}/${repo}.git`, { cwd: clone_scratchpad });

    const repo_path = get_repo_path(repo);

    await exec(`git config user.name MergeMasterXXL`, { cwd: repo_path });
    await exec(`git config user.email 'N/A'`, { cwd: repo_path });

    logger.info(`Cloned ${owner}/${repo} to ${repo_path}`);
}

export async function delete_branch(repo: string, branch: string) {
    await exec(`git branch -D '${branch}'`, { cwd: get_repo_path(repo) });
}

export async function checkout_branch(repo: string, branch: string) {
    try {
        await exec(`git checkout ${branch}`, { cwd: get_repo_path(repo) });
        return true;
    } catch (e) {
        logger.info(`Could not checkout branch ${branch}: ${e}`);
        return false;
    }
}

export async function checkout_new_branch(repo: string, branch: string) {
    await exec(`git checkout -b ${branch}`, { cwd: get_repo_path(repo) });
}

export async function checkout_pr(repo: string, permalink: string) {
    await exec(`gh pr checkout '${permalink}'`, { cwd: get_repo_path(repo) });
}

export async function merge_branch(repo: string, source_branch: string) {
    await exec(`git merge --no-edit --commit '${source_branch}'`, { cwd: get_repo_path(repo) });
}

export type Commit = {
    commit: string;
    author_name: string;
    author_email: string;
    author_date: Date;
    committer_name: string;
    committer_email: string;
    committer_date: Date;
    subject: string;
    message: string;
};

const COMMIT_FORMAT = {
    commit: "%H",
    author_name: "%aN",
    author_email: "%aE",
    author_date: "%ai",
    committer_name: "%cN",
    committer_email: "%cE",
    committer_date: "%ci",
    subject: "%f",
};

export async function get_commits(repo: string, ref: string): Promise<Commit[]> {
    try {
        const format = JSON.stringify(COMMIT_FORMAT).replaceAll('"', '§');
        const result = await exec(`git log --pretty=format:"${format}, " ${ref}`, { cwd: get_repo_path(repo) });

        var stdout = result.stdout.trim();

        if (stdout.endsWith(",")) {
            stdout = stdout.substring(0, stdout.length - 1);
        }

        stdout = stdout.replaceAll('§', '"');

        const commits: Commit[] = JSON.parse(`[${stdout}]`);

        for (const commit of commits) {
            commit.author_date = new Date(commit.author_date);
            commit.committer_date = new Date(commit.committer_date);
            commit.message = (await exec(`git log --pretty=format:"%b" ${commit.commit}`, { cwd: get_repo_path(repo) })).stdout.trim();
        }

        return commits;
    } catch (e) {
        logger.error(`Could not fetch commits for '${ref}': ${e}`);
        return [];
    }
}

export async function commit(repo: string, subject: string, message?: string) {
    var lines = [
        subject || ""
    ];

    if (message) {
        lines = lines.concat([
            "",
            ...message.split("\n")
        ]);
    }

    await exec(`git add -A`, { cwd: get_repo_path(repo) });
    await exec(`git commit --no-edit --allow-empty -m '${lines.join("\n")}'`, { cwd: get_repo_path(repo) });
}

export async function force_push(repo: string, branch: string) {
    await exec(`git push -f origin ${branch}`, { cwd: get_repo_path(repo) });
}

export async function push(repo: string, branch: string) {
    await exec(`git push origin ${branch}`, { cwd: get_repo_path(repo) });
}

export async function spotless_apply(repo: string) {
    if (fs.existsSync(path.join(get_repo_path(repo), "gradlew"))) {
        logger.info(`Applying spotless for ${repo}`);

        await exec(`./gradlew spotlessApply`, { cwd: get_repo_path(repo) });

        await commit(repo, "sa");
    }
}

export async function update_repo(repo: string) {
    if (fs.existsSync(path.join(get_repo_path(repo), "gradlew"))) {
        logger.info(`Updating dependencies and buildscript (as needed) for ${repo}`);

        await exec(`./gradlew updateDependencies`, { cwd: get_repo_path(repo) });
        await exec(`./gradlew updateBuildscript`, { cwd: get_repo_path(repo) });

        await commit(repo, "update");
    }
}
