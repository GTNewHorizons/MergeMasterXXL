import _ from "lodash";
import { checkout_branch, clone_repo, force_push, get_commits, get_repos, normalize_repo_id, parse_repo_id, RepoId, RepoInfo, stringify_repo_id, unclone_repo, update_repo } from "./requests/repos";
import { get_branch_commits, get_dev_branch_status } from "./requests/branches";
import { get_pr, parse_pr, PRId, stringify_pr, get_merged_prs } from "./requests/prs";
import { dev_branch, dryrun, logger, repos } from "./env";
import { DepGraph } from "dependency-graph";
import { push_tag, get_latest_tag, get_latest_tags, get_tag_for_ref, increment_tag, ParsedTag, stringify_tag, wait_for_action, create_tag, WorkflowId } from "./requests/tags";
import yaml from "yaml";

const repo_ids = repos.length === 0 ? await get_repos() : _.map(repos, normalize_repo_id);

logger.debug(`Scanning repos: ${repo_ids.map(x => `"${x}"`).join(", ")}`);

logger.info(`Scanning ${repo_ids.length} repos`);

/// PRs merged into the master branch
const masterPRs: {[repo:string]: PRId[]} = {};
/// PRs merged into the dev branch
const devPRs: {[repo:string]: PRId[]} = {};

/// PRs required by the master branch
const masterDependencies: {[repo:string]: PRId[]} = {};
/// PRs required by the dev branch
const devDependencies: {[repo:string]: PRId[]} = {};

const has_dev: {[repo:string]: boolean} = {};

async function fetch_master_prs(repo_id: RepoId, default_branch: string) {
    const latest_master = await get_latest_tag(repo_id);
    const commits_since_master_tag = await get_commits(repo_id, `${stringify_tag(latest_master)}..HEAD`);

    if (commits_since_master_tag.length === 0) return;

    const merge_commits = new Set(_(commits_since_master_tag)
        .map("prid")
        .filter(Boolean)
        .map(x => x as number)
        .value());

    const merged_prs = await get_merged_prs(repo_id, default_branch, merge_commits, _.toInteger(merge_commits.size * 1.5));

    const repo_info = parse_repo_id(repo_id);

    masterPRs[repo_id] = _.map(merged_prs.prs, pr => ({ repo_id: repo_info, pr: pr.number }));
    masterDependencies[repo_id] = merged_prs.dependencies;
}

async function fetch_dev_prs(repo_id: RepoId) {
    if (await checkout_branch(repo_id, dev_branch)) {
        has_dev[repo_id] = true;

        const dev_commits = await get_commits(repo_id, `${dev_branch}~5..${dev_branch}`);
    
        const status = get_dev_branch_status(dev_commits);
    
        if (status) {
            devPRs[repo_id] = _.map(status["Included PRs"], pr => parse_pr(pr) as PRId);
            devDependencies[repo_id] = _(status["Dependencies"]).map(parse_pr).filter(Boolean).value() as PRId[];
        }

        await checkout_branch(repo_id, "-");
    }
}

logger.info(yaml.stringify({
    "Scanning PR dependencies for repos": repo_ids
}));

for (const repo_id of repo_ids) {
    await unclone_repo(repo_id);

    const { default_branch } = await clone_repo(repo_id, false);

    await fetch_master_prs(repo_id, default_branch);
    await fetch_dev_prs(repo_id);

    await unclone_repo(repo_id);
}

if (!_.isEmpty(masterPRs)) {
    logger.info(yaml.stringify({
        "PRs merged into master branches": _.mapValues(masterPRs, value => _.map(value, stringify_pr))
    }));
}

if (!_.isEmpty(masterDependencies)) {
    logger.info(yaml.stringify({
        "Dependencies between repo master branches (for tagging order)": _.mapValues(masterDependencies, value => _.map(value, stringify_pr))
    }));
}

if (!_.isEmpty(devPRs)) {
    logger.info(yaml.stringify({
        "PRs merged into dev branches": _.mapValues(devPRs, value => _.map(value, stringify_pr))
    }));
}

if (!_.isEmpty(devDependencies)) {
    logger.info(yaml.stringify({
        "Dependencies between repo dev branches (for tagging order)": _.mapValues(devDependencies, value => _.map(value, stringify_pr))
    }));
}

/// A spec string of the format Org/Repo:Branch
type PRDestStr = string;
type PRDestination = {
    repo_info: RepoInfo;
    branch: "master" | "dev";
};

function stringify_dest(dest: PRDestination): PRDestStr {
    return `${stringify_repo_id(dest.repo_info)}:${dest.branch}`;
}

const pr_locations: {[pr: string]: PRDestination} = {};

for (const repo_id in devPRs) {
    for (const pr_id of devPRs[repo_id]) {
        pr_locations[stringify_pr(pr_id)] = {
            repo_info: parse_repo_id(repo_id),
            branch: "dev",
        };
    }
}

for (const repo_id in masterPRs) {
    for (const pr_id of masterPRs[repo_id]) {
        pr_locations[stringify_pr(pr_id)] = {
            repo_info: parse_repo_id(repo_id),
            branch: "master",
        };
    }
}

logger.info(yaml.stringify({
    "PR locations": _.mapValues(pr_locations, stringify_dest)
}));

const graph = new DepGraph<PRDestination>();

for (const repo of repo_ids) {
    graph.addNode(`${repo}:master`, {
        repo_info: parse_repo_id(repo),
        branch: "master",
    });

    if (has_dev[repo]) {
        graph.addNode(`${repo}:dev`, {
            repo_info: parse_repo_id(repo),
            branch: "dev",
        });
    
        // Force the dev tagging for each repo to happen after master. If something causes a cyclic dependency, the repo deps are fucked regardless and we should bail
        graph.addDependency(`${repo}:dev`, `${repo}:master`);
    }
}

var success = true;

for (const repo of repo_ids) {
    if (masterDependencies[repo]) {
        for (const dep of masterDependencies[repo]) {
            const depDest = pr_locations[stringify_pr(dep)];
    
            if (!depDest) {
                logger.error(`Repo ${repo} requires PR ${stringify_pr(dep)}, which does not exist`);
                success = false;
                continue;
            }
    
            if (depDest.branch === "dev") {
                logger.warn(`Master branch for ${repo} depends on dev PR: ${stringify_pr(dep)}`);
            }
    
            const from = `${normalize_repo_id(repo)}:master`;
            const to = stringify_dest(depDest);
    
            if (!graph.hasNode(to)) {
                logger.warn(`Ignoring invalid depencency for ${repo}: ${to}`);
                continue;
            }
    
            graph.addDependency(from, to);
        }
    }

    if (devDependencies[repo]) {
        for (const dep of devDependencies[repo]) {
            const depDest = pr_locations[stringify_pr(dep)];
    
            if (!depDest) {
                logger.error(`Repo ${repo} requires PR ${stringify_pr(dep)}, which does not exist`);
                success = false;
                continue;
            }
    
            const from = `${normalize_repo_id(repo)}:dev`;
            const to = stringify_dest(depDest);
    
            if (!graph.hasNode(to)) {
                logger.warn(`Ignoring invalid depencency for ${repo}: ${to}`);
                continue;
            }
    
            graph.addDependency(from, to);
        }
    }
}

if (!success) {
    throw new Error("PR dependency check failed");
}

const passed_workflows: {[repo: string]: boolean} = {};
const workflows: {[target: string]: WorkflowId} = {};

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

logger.info(yaml.stringify({
    "Tagging order": graph.overallOrder()
}));

for (const target of graph.overallOrder()) {
    logger.info(`Creating releases for ${target}`);

    const dest = graph.getNodeData(target);

    const repo_id = stringify_repo_id(dest.repo_info);

    try {
        const { default_branch } = await clone_repo(repo_id);

        const branch = dest.branch === "dev" ? dev_branch : default_branch;

        const latestTags = await get_latest_tags(repo_id);
        latestTags.sort(compare_tag_versions);

        const latestTag = _.last(latestTags) as ParsedTag;

        if (await checkout_branch(repo_id, branch)) {
            if (await get_tag_for_ref(repo_id, branch)) {
                logger.info(`${branch} branch for ${repo_id} already has a tag: it will not be tagged again because it has not been updated`)
            } else {
                const tag_name = increment_tag(latestTag, dest.branch === "dev");

                if (dest.branch === "dev") {
                    pre_tags[repo_id] = tag_name;
                } else {
                    master_tags[repo_id] = tag_name;
                }
    
                logger.info(`Creating tag ${tag_name} off of ${branch} branch (target: ${target})`);
    
                const tag_overrides: {[repo_id:string]: string} = {};

                for (const dep_target of graph.dependenciesOf(target)) {
                    const target_data = graph.getNodeData(dep_target);

                    // Skip the dev -> master dep because it's irrelevant here
                    if (_.isMatch(dest.repo_info, target_data.repo_info) && target_data.branch === "master") {
                        continue;
                    }

                    logger.info(`Checking dependency ${dep_target} (target: ${target})`);
    
                    tag_overrides[target_data.repo_info.repo] = target_data.branch === "dev" ?
                        pre_tags[stringify_repo_id(target_data.repo_info)] :
                        master_tags[stringify_repo_id(target_data.repo_info)];

                    if (passed_workflows[dep_target]) {
                        logger.info(`Workflow was already waited for and succeeded: skipping`);
                        continue;
                    }

                    const workflow = workflows[dep_target];
    
                    if (workflow) {
                        if (!await wait_for_action(stringify_repo_id(target_data.repo_info), target_data.branch, workflow)) {
                            logger.info(`Actions for target ${dep_target} failed: cannot build ${target}, this experimental will be cancelled`);
                            throw new Error("Could not build dependency");
                        }
                    } else {
                        logger.warn(`Dependency ${dep_target} did not have a corresponding workflow`);
                    }

                    passed_workflows[dep_target] = true;
                }
    
                logger.info(`Actions for all dependencies have finished: tagging ${branch} branch (target: ${target})`);

                await update_repo(repo_id, tag_overrides);
                if (!dryrun) await force_push(repo_id, branch);
    
                await create_tag(repo_id, tag_name, branch);

                if (!dryrun) {
                    const workflow_id = await push_tag(repo_id, tag_name, branch);
        
                    logger.info(`Created and pushed ${tag_name} (base branch: ${branch}, target: ${target}, workflow id: ${workflow_id})`);
        
                    if (workflow_id) {
                        workflows[target] = workflow_id as number;
                    }
                } else {
                    logger.info(`Created ${tag_name} (base branch: ${branch}, target: ${target})`);
                }
            }
        }
    } finally {
        if (!dryrun) await unclone_repo(repo_id);
    }
}

logger.info("Finished tagging: waiting for all workflows to finish");

for (const target of graph.overallOrder()) {
    if (passed_workflows[target]) {
        logger.info(`Workflow for ${target} was already waited for and succeeded: skipping`);
        continue;
    }

    const target_data = graph.getNodeData(target);

    const workflow = workflows[target];

    if (workflow) {
        logger.info(`Waiting for ${target}`);
    
        if (!await wait_for_action(stringify_repo_id(target_data.repo_info), target_data.branch, workflow)) {
            logger.info(`Actions for target ${target} failed: cannot build ${target}, this experimental will be cancelled`);
            throw new Error("Could not build target");
        }
    }
}
