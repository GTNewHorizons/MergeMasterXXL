import _ from "lodash";

import axios from "axios";
import path from "path";
import child_process from "child_process";
import { promisify } from "util";
import { gh_token, is_gh_action, logger, mmxxl_blacklist } from "../env";
import { clone_scratchpad, spotless_blacklist, update_deps_blacklist } from "../env";
import fs from "fs";
import { parseStringPromise } from "xml2js";
import { parse_pr, PRId } from "./prs";
import { create_tag, get_latest_tag } from "./tags";
import yaml from "yaml";

const exec0 = promisify(child_process.exec);
export const exec: typeof exec0 = function(...args: any[]) {
    logger.debug(`Executing: ${arguments[0]}`);
    return (exec0 as any)(...args);
};

export type RepoId = string;
export type RepoInfo = {
    owner: string;
    repo: string;
};

export function parse_repo_id(repo_id: RepoId): RepoInfo {
    if (repo_id.startsWith("https://github.com/")) {
        repo_id = repo_id.replace("https://github.com/", "");
    }

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
    logger.info("Fetching https://raw.githubusercontent.com/GTNewHorizons/DreamAssemblerXXL/refs/heads/master/releases/manifests/experimental.json");

    const data = await axios.get("https://raw.githubusercontent.com/GTNewHorizons/DreamAssemblerXXL/refs/heads/master/releases/manifests/experimental.json");

    return _.map(_.keys(data.data.github_mods), normalize_repo_id);
}

export function get_repo_path(repo_id: RepoId) {
    const { owner, repo } = parse_repo_id(repo_id);
    
    return path.join(clone_scratchpad, owner, repo);
}

export async function clone_repo(repo_id: RepoId, checkout: boolean = true): Promise<{default_branch: string}> {
    const { owner, repo } = parse_repo_id(repo_id);
    
    const repo_path = get_repo_path(repo_id);

    if (fs.existsSync(repo_path)) {
        logger.info(`Not cloning ${repo_id}: path already exists`);

        const default_branch = (await exec(`git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`, { cwd: repo_path })).stdout.trim();
    
        return {
            default_branch
        };
    }

    if (is_gh_action) {
        await exec(`git clone ${checkout ? "" : "--no-checkout"} https://x-access-token:${gh_token}@github.com/${owner}/${repo}.git ${repo_path}`, {
            cwd: clone_scratchpad,
            env: { GH_TOKEN: gh_token }
        });
    } else {
        await exec(`git clone ${checkout ? "" : "--no-checkout"} git@github.com:${owner}/${repo}.git ${repo_path}`, {
            cwd: clone_scratchpad,
            env: { GH_TOKEN: gh_token }
        });
    }

    await exec(`git config user.name MergeMasterXXL`, { cwd: repo_path });
    await exec(`git config user.email 'N/A'`, { cwd: repo_path });

    const default_branch = (await exec(`git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'`, { cwd: repo_path })).stdout.trim();

    logger.info(`Cloned ${owner}/${repo} (default branch: ${default_branch})`);

    try {
        await get_latest_tag(repo_id);
    } catch (e) {
        logger.info(`Could not find tag for master branch: creating one`);
        await create_tag(repo_id, "0.0.0");
    }

    return {
        default_branch
    };
}

export async function unclone_repo(repo_id: RepoId) {
    const { owner, repo } = parse_repo_id(repo_id);
    const repo_path = get_repo_path(repo_id);
    
    var did_something = false;

    if (fs.existsSync(repo_path)) {
        await exec(`rm -rf ${repo_path}`, { cwd: clone_scratchpad });
        did_something = true;
    }

    if (fs.existsSync(path.join(clone_scratchpad, owner))) {
        await exec(`rmdir --ignore-fail-on-non-empty ${owner}`, { cwd: clone_scratchpad });
        did_something = true;
    }

    if (did_something) logger.info(`Uncloned ${owner}/${repo}`);
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
    const { pr } = parse_pr(permalink) as PRId;

    await exec(`gh pr checkout '${permalink}' -b ${pr}`, { cwd: get_repo_path(repo_id) });
}

export async function merge_branch(repo_id: RepoId, source_branch: string, message: string | null = null) {
    if (message) {
        message = ` --no-ff -m "${message}" `;
    } else {
        message = "";
    }

    await exec(`git merge --no-edit --commit ${message} '${source_branch}'`, { cwd: get_repo_path(repo_id) });
}


export async function abort_merge(repo_id: RepoId) {
    await exec(`git merge --abort`, { cwd: get_repo_path(repo_id) });
}

export type Commit = {
    commit: string;
    author_name: string;
    author_email: string;
    author_date: Date;
    committer_name: string;
    committer_email: string;
    committer_date: Date;
    prid?: number;
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
    subject: "%s",
};

export const COMMIT_PR = /\(\#(?<pr>\d+)\)$/;

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

            const match = COMMIT_PR.exec(commit.subject);

            if (match && match.groups) {
                commit.prid = parseInt(match.groups["pr"]);

                commit.subject = commit.subject.slice(0, commit.subject.length - match.groups["pr"].length);
            }
        }

        return commits;
    } catch (e) {
        logger.error(`Could not fetch commits for '${ref}': ${e}`);
        return [];
    }
}

export async function is_dirty(repo_id: RepoId) {
    const output = await exec(`git status --porcelain`, { cwd: get_repo_path(repo_id) });

    return output.stdout.trim().length > 0;
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
    if (_.includes(spotless_blacklist, repo_id)) {
        logger.info(`Spotless for ${repo_id} is blacklisted: skipping it`);
        return;
    }

    if (fs.existsSync(path.join(get_repo_path(repo_id), "gradlew"))) {
        logger.info(`Applying spotless for ${repo_id}`);

        try {
            await exec(`./gradlew --stop`, { cwd: get_repo_path(repo_id) });
            await exec(`./gradlew spotlessApply`, { cwd: get_repo_path(repo_id) });

            await commit(repo_id, "sa");
        } catch (e) {
            logger.info(`Could not run spotlessApply: ${e}`);

            await exec(`git reset --hard`, { cwd: get_repo_path(repo_id) });
        }
    }
}

export async function update_repo(repo_id: RepoId, tag_overrides: {[repo:string]: string}) {
    if (fs.existsSync(path.join(get_repo_path(repo_id), "gradlew"))) {
        logger.info(`Updating dependencies and buildscript (as needed) for ${repo_id}`);

        await update_dependencies(repo_id, tag_overrides);

        try {
            await exec(`./gradlew updateBuildscript`, { cwd: get_repo_path(repo_id) });
        } catch (e) {
            logger.warn(`Could not run gradlew updateBuildscript: ${e}`);
        }

        if (await is_dirty(repo_id)) {
            await commit(repo_id, "update", undefined);
        }
    }
}

const GTNH_DEP = /com\.github\.GTNewHorizons:(?<repo>[^:]+):(?<version>[^:'"]+)(?<stream>:[^:'"]+)?/;

async function update_dependencies(repo_id: RepoId, tag_overrides: {[repo:string]: string}) {
    if (_.includes(update_deps_blacklist, repo_id)) {
        logger.info(`Updating dependencies for ${repo_id} is blacklisted: skipping it`);
        return;
    }

    const deps = path.join(get_repo_path(repo_id), "dependencies.gradle");

    if (!fs.existsSync(deps)) return;

    const lines = fs.readFileSync(deps).toString().split("\n");

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
        fs.writeFileSync(deps, lines.join("\n"));
    }
}

const release_cache: {[dep:string]: string|null} = {};

type MavenMetadata = {
    metadata: {
        groupId: string[];
        artifactId: [];
        versioning: Array<{
            latest: string[];
            release: string[];
            versions: Array<{
                version: string[];
            }>;
        }>;
    }
};

async function get_latest_release(dep: string){
    try {
        if (release_cache[dep] !== undefined) return release_cache[dep];

        const resp: string = (await axios.get(`https://nexus.gtnewhorizons.com/repository/public/com/github/GTNewHorizons/${dep}/maven-metadata.xml`, { responseType: "document" })).data;
    
        const doc: MavenMetadata = await parseStringPromise(resp);
    
        const latest = _(doc.metadata.versioning)
            .flatMap(x => x.versions)
            .flatMap(x => x.version)
            .reverse()
            .filter(v => !v.endsWith("-pre"))
            .value();

        release_cache[dep] = latest[0] || null;

        return latest[0] || null;
    } catch (e) {
        if (e.status == 404) {
            release_cache[dep] = null;
            return null;
        }

        logger.error(`Could not get latest version for ${dep}: ${e.message}`);
    }
}

export type RepoConfig = {
    blacklisted: boolean;
    updateDependencies: boolean;
    applySpotless: boolean;
    thirdPartyPRs: PRId[];
};

export async function get_repo_config(repo_id: RepoId): Promise<RepoConfig | null> {
    try {
        repo_id = normalize_repo_id(repo_id);

        if (!fs.existsSync(path.join(get_repo_path(repo_id), ".mmxxl-config.yaml"))) {
            logger.debug(`Repo ${repo_id} does not have a config (file ${path.join(get_repo_path(repo_id), ".mmxxl-config.yaml")} was missing)`);
            return null;
        }

        const text = fs.readFileSync(path.join(get_repo_path(repo_id), ".mmxxl-config.yaml")).toString();

        const raw = yaml.parse(text);

        return {
            blacklisted: typeof(raw.blacklisted) !== "boolean" ? mmxxl_blacklist.includes(repo_id) : Boolean(raw.blacklisted),
            updateDependencies: typeof(raw.updateDependencies) !== "boolean" ? update_deps_blacklist.includes(repo_id) : Boolean(raw.updateDependencies),
            applySpotless: typeof(raw.applySpotless) !== "boolean" ? spotless_blacklist.includes(repo_id) : Boolean(raw.applySpotless),
            thirdPartyPRs: _.filter(_.map(raw.thirdPartyPRs || [], parse_pr), x => x !== null),
        };
    } catch (e) {
        logger.error(`Could not read config for repo ${repo_id}: ${e}`);

        return null;
    }
}
