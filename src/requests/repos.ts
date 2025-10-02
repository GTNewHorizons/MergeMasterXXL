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
import { parseStringPromise } from "xml2js";

const exec0 = promisify(child_process.exec);
export const exec: typeof exec0 = function(...args: any[]) {
    logger.info(`Executing: ${arguments[0]}`);
    return (exec0 as any)(...args);
};

const repo_blacklist = [
    
];

export type RepoId = string;
export type RepoInfo = {
    owner: string;
    repo: string;
};

export function parse_repo_id(repo_id: RepoId): RepoInfo {
    const chunks = _.filter(repo_id.split("/"), Boolean);

    if (chunks.length == 1) {
        return {
            owner: "GTNewHorizons",
            repo: chunks[0]
        };
    } else {
        return {
            owner: chunks[0],
            repo: chunks[1]
        };
    }
}

export function stringify_repo_id(repo_info: RepoInfo): RepoId {
    return `${repo_info.owner}/${repo_info.repo}`;
}

export function normalize_repo_id(repo_id: RepoId): RepoId {
    return stringify_repo_id(parse_repo_id(repo_id));
}

export async function get_repos(): Promise<RepoId[]> {
    const data = await axios.get("https://raw.githubusercontent.com/GTNewHorizons/DreamAssemblerXXL/refs/heads/master/releases/manifests/experimental.json");

    const repos = _.keys(data.data.github_mods);

    _.remove(repos, repo => _.includes(repo_blacklist, repo));

    return repos;
}

export function get_repo_path(repo_id: RepoId) {
    const { owner, repo } = parse_repo_id(repo_id);
    
    return path.join(clone_scratchpad, owner, repo);
}

export async function clone_repo(repo_id: RepoId): Promise<void> {
    const { owner, repo } = parse_repo_id(repo_id);
    
    const repo_path = get_repo_path(repo_id);

    await exec(`git clone git@github.com:${owner}/${repo}.git ${repo_path}`, { cwd: clone_scratchpad });

    await exec(`git config user.name MergeMasterXXL`, { cwd: repo_path });
    await exec(`git config user.email 'N/A'`, { cwd: repo_path });

    logger.info(`Cloned ${owner}/${repo}`);
}

export async function unclone_repo(repo_id: RepoId): Promise<void> {
    const { owner, repo } = parse_repo_id(repo_id);
    const repo_path = get_repo_path(repo_id);
    
    await exec(`rm -rf ${repo_path}`, { cwd: clone_scratchpad });
    await exec(`rmdir --ignore-fail-on-non-empty ${owner}`, { cwd: clone_scratchpad });

    logger.info(`Uncloned ${owner}/${repo}`);
}

export async function delete_branch(repo_id: RepoId, branch: string) {
    try {
        await exec(`git branch -D '${branch}'`, { cwd: get_repo_path(repo_id) });
    } catch (e) {
        logger.info(`Could not delete branch ${repo_id}:${branch}: ${e}`);
    }
}

export async function checkout_branch(repo_id: RepoId, branch: string) {
    try {
        await exec(`git checkout ${branch}`, { cwd: get_repo_path(repo_id) });
        return true;
    } catch (e) {
        logger.info(`Could not checkout branch ${branch}: ${e}`);
        return false;
    }
}

export async function checkout_new_branch(repo_id: RepoId, branch: string) {
    await exec(`git checkout -b ${branch}`, { cwd: get_repo_path(repo_id) });
}

export async function checkout_pr(repo_id: RepoId, permalink: string) {
    await exec(`gh pr checkout '${permalink}'`, { cwd: get_repo_path(repo_id) });
}

export async function merge_branch(repo_id: RepoId, source_branch: string) {
    await exec(`git merge --no-edit --commit '${source_branch}'`, { cwd: get_repo_path(repo_id) });
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

export async function get_commits(repo_id: RepoId, ref: string): Promise<Commit[]> {
    try {
        const format = JSON.stringify(COMMIT_FORMAT).replaceAll('"', '§');
        const result = await exec(`git log --pretty=format:"${format}, " ${ref}`, { cwd: get_repo_path(repo_id) });

        var stdout = result.stdout.trim();

        if (stdout.endsWith(",")) {
            stdout = stdout.substring(0, stdout.length - 1);
        }

        stdout = stdout.replaceAll('§', '"');

        const commits: Commit[] = JSON.parse(`[${stdout}]`);

        for (const commit of commits) {
            commit.author_date = new Date(commit.author_date);
            commit.committer_date = new Date(commit.committer_date);
            commit.message = (await exec(`git log --pretty=format:"%b" ${commit.commit}`, { cwd: get_repo_path(repo_id) })).stdout.trim();
        }

        return commits;
    } catch (e) {
        logger.error(`Could not fetch commits for '${ref}': ${e}`);
        return [];
    }
}

export async function commit(repo_id: RepoId, subject: string, message?: string, amend: boolean = false) {
    var lines = [
        subject || ""
    ];

    if (message) {
        lines = lines.concat([
            "",
            ...message.split("\n")
        ]);
    }

    await exec(`git add -A`, { cwd: get_repo_path(repo_id) });
    await exec(`git commit --no-edit --allow-empty ${amend ? "--amend" : ""} -m '${lines.join("\n")}'`, { cwd: get_repo_path(repo_id) });
}

export async function force_push(repo_id: RepoId, branch: string) {
    await exec(`git push -f origin ${branch}`, { cwd: get_repo_path(repo_id) });
}

export async function push(repo_id: RepoId, branch: string) {
    await exec(`git push origin ${branch}`, { cwd: get_repo_path(repo_id) });
}

export async function spotless_apply(repo_id: RepoId) {
    if (fs.existsSync(path.join(get_repo_path(repo_id), "gradlew"))) {
        logger.info(`Applying spotless for ${repo_id}`);

        await exec(`./gradlew spotlessApply`, { cwd: get_repo_path(repo_id) });

        await commit(repo_id, "sa");
    }
}

export async function update_repo(repo_id: RepoId, tag_overrides: {[repo:string]: string}) {
    if (fs.existsSync(path.join(get_repo_path(repo_id), "gradlew"))) {
        logger.info(`Updating dependencies and buildscript (as needed) for ${repo_id}`);

        await update_to_pres(repo_id, tag_overrides);
        await exec(`./gradlew updateBuildscript`, { cwd: get_repo_path(repo_id) });

        const commits = await get_commits(repo_id, "HEAD -n 1");

        const ammend = commits[0] && commits[0].subject == "update";

        await commit(repo_id, "update", undefined, ammend);
    }
}

const GTNH_DEP = /com\.github\.GTNewHorizons:(?<repo>[^:]+):(?<version>[^:'"]+)(?<stream>:[^:'"]+)?/;

async function update_to_pres(repo_id: RepoId, tag_overrides: {[repo:string]: string}) {
    const lines = fs.readFileSync(path.join(get_repo_path(repo_id), "dependencies.gradle")).toString().split("\n");

    var changed = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        const match = GTNH_DEP.exec(line);

        if (match && match.groups) {
            const latest = tag_overrides[match.groups["repo"]] || await get_latest_release(match.groups["repo"]);

            if (latest && latest != match.groups["version"]) {
                logger.info(`Updated ${match.groups["repo"]}: ${match.groups["version"]} -> ${latest}`);

                line = line.replace(match.groups["version"], latest);

                lines[i] = line;
                changed = true;
            }
        }
    }

    if (changed) {
        fs.writeFileSync(path.join(get_repo_path(repo_id), "dependencies.gradle"), lines.join("\n"));
    }
}

async function get_latest_release(dep: string){
    const resp: string = (await axios.get(`https://nexus.gtnewhorizons.com/repository/public/com/github/GTNewHorizons/${dep}/maven-metadata.xml`, { responseType: "document" })).data;

    const doc = await parseStringPromise(resp);

    return doc.metadata.versioning[0].latest;
}
