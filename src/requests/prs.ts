import _ from "lodash";
import { GQList, octokit } from "./types";
import { logger } from "../env";
import { DepGraph } from "dependency-graph";
import { get_repo_config, get_repos, parse_repo_id, RepoId, RepoInfo } from "./repos";
import { mmxxl_blacklist } from "../env";

/** ISO-8601 encoded date */
export type DateString = string;

export type ReviewDecision = "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED" | null;

export type PRId = {
    repo_id: RepoInfo;
    pr: number;
};

export type PullRequest = {
    labels: string[],
    baseRefName: string,
    bodyText: string,
    headRefName: string,
    id: string,
    isDraft: boolean,
    locked: boolean,
    merged: boolean,
    /** PR number */
    number: number,
    /** PR browser link */
    permalink: string,
    title: string,
    updatedAt: Date,
    dependencies: PRId[],
};

type QLPR = {
    labels: {
        nodes: Array<{ name: string }>
    },
    baseRefName: string,
    bodyText: string,
    headRefName: string,
    id: string,
    isDraft: boolean,
    locked: boolean,
    merged: boolean,
    /** PR number */
    number: number,
    /** PR browser link */
    permalink: string,
    title: string,
    updatedAt: string,
};

type RespPRs = {
    resource: {
        repository: {
            pullRequests: GQList<QLPR>
        }
    }
};

const get_repo_prs = `
query($org: URI!, $repo: String!, $cursor: String) {
    resource(url: $org) {
        ... on Organization {
            repository(name: $repo) {
                pullRequests(states: [OPEN], first: 100, after: $cursor) {
                    nodes {
                        labels(first: 10) {
                            nodes {
                                name
                            }
                        }
                        baseRefName
                        bodyText
                        headRefName
                        id
                        isDraft
                        locked
                        merged
                        number
                        permalink
                        title
                        updatedAt
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        }
    }
}
`;

const latest_merged_prs = `
query ($org: URI!, $repo: String!) {
    resource(url: $org) {
        ... on Organization {
            repository(name: $repo) {
                pullRequests(states: [MERGED], last: 100, orderBy: { field: UPDATED_AT, direction: ASC }) {
                    nodes {
                        labels(first: 10) {
                            nodes {
                                name
                            }
                        }
                        baseRefName
                        bodyText
                        headRefName
                        id
                        isDraft
                        locked
                        merged
                        number
                        permalink
                        title
                        updatedAt
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        }
    }
}
`;

const BLOCKER_LABELS = ["affects balance", "not ready for testing"];
const REQUIRED_LABELS = ["testing on zeta", ":construction: testing on zeta"];

/** PR cannot be reverted and the experimental must be cancelled if the PR could not be included after it was previously included */
export const NOT_REVERTABLE = "not revertable";

export const NEWLINE = /[\n\r]+/;
const PR_HASH = /^(?<owner>\w+)?#(?<pr>\d+)$/;

export type PRInfo = {
    prs: PullRequest[];
    dependencies: PRId[];
}

function load_pr(repo_info: RepoInfo, ql: QLPR): PullRequest | null {
    const out: PullRequest = {
        labels: ql.labels.nodes.map(n => n.name.toLowerCase()),
        baseRefName: ql.baseRefName,
        bodyText: ql.bodyText,
        headRefName: ql.headRefName,
        id: ql.id,
        isDraft: ql.isDraft,
        locked: ql.locked,
        number: ql.number,
        merged: ql.merged,
        permalink: ql.permalink,
        title: ql.title,
        updatedAt: new Date(ql.updatedAt),
        dependencies: [],
    };

    const lines = out.bodyText.split(NEWLINE);

    for (const line of lines) {
        if (!line.startsWith("depends on:")) continue;

        var dep = line.replace("depends on:", "").trim();

        const hash = PR_HASH.exec(dep);

        if (hash && hash.groups) {
            dep = stringify_pr({
                repo_id: {
                    owner: hash.groups["owner"] || repo_info.owner,
                    repo: repo_info.repo,
                },
                pr: parseInt(hash.groups["pr"])
            });
        }

        const pr_id = parse_pr(dep);

        if (!pr_id) {
            logger.error(`PR ${out.permalink} depends on invalid PR '${dep}': it will be removed from this release`);
            return null;
        }

        out.dependencies.push(pr_id);
    }

    return out;
}

export async function get_prs(repo_id: RepoId, default_branch: string): Promise<PRInfo> {
    const repo_info = parse_repo_id(repo_id);
    const { owner, repo } = repo_info;

    const resp: RespPRs = await octokit.graphql(get_repo_prs, { org: `https://github.com/${owner}`, repo, cursor: null });

    const allPRs = [...resp.resource.repository.pullRequests.nodes];

    var pageInfo = resp.resource.repository.pullRequests.pageInfo;

    while (pageInfo.hasNextPage) {
        const resp2: RespPRs = await octokit.graphql(get_repo_prs, { owner, repo, cursor: pageInfo.endCursor });
        pageInfo = resp2.resource.repository.pullRequests.pageInfo;

        for (const pr of resp2.resource.repository.pullRequests.nodes) {
            allPRs.push(pr);
        }
    }

    const config = await get_repo_config(repo_id);

    const third_party: PullRequest[] = [];

    if (config) {
        for (const pr_id of config.thirdPartyPRs) {
            logger.info(`Fetching info for third party PR: ${stringify_pr(pr_id)}`);
    
            const pr = await get_pr(pr_id);
    
            if (pr) third_party.push(pr);
        }
    }

    const validPRs = _(allPRs)
        .filter({ baseRefName: default_branch, isDraft: false, locked: false })
        .map(pr => load_pr(repo_info, pr))
        .filter(Boolean)
        .map(pr => pr as PullRequest)
        .filter(pr => _.intersection(pr.labels, BLOCKER_LABELS).length == 0)
        .filter(pr => _.intersection(pr.labels, REQUIRED_LABELS).length > 0)
        .concat(third_party)
        .value();

    const graph = new DepGraph();

    for (const pr of validPRs) {
        graph.addNode(pr.permalink);
    }

    const crossRepoDeps: PRId[] = [];

    for (const pr of validPRs) {
        for (const dep of pr.dependencies) {
            const dep_permalink = stringify_pr(dep);
        
            if (!graph.hasNode(dep_permalink)) {
                graph.addNode(dep_permalink);
            }
        
            graph.addDependency(pr.permalink, dep_permalink);
        
            if (dep.repo_id.owner != "GTNewHorizons" || dep.repo_id.repo != repo) {
                crossRepoDeps.push(dep);
            }
        }
    }

    const order = graph.overallOrder();

    const sortedPRs = _.sortBy(validPRs, pr => order.indexOf(pr.permalink));

    return {
        prs: sortedPRs,
        dependencies: crossRepoDeps
    };
}

export async function get_merged_prs(repo_id: RepoId, default_branch: string, whitelist: Set<number>, count: number = 100): Promise<PRInfo> {
    const repo_info = parse_repo_id(repo_id);
    const { owner, repo } = repo_info;

    const resp: RespPRs = await octokit.graphql(latest_merged_prs, { org: `https://github.com/${owner}`, repo, cursor: null });

    const allPRs = [...resp.resource.repository.pullRequests.nodes];

    var pageInfo = resp.resource.repository.pullRequests.pageInfo;

    while (pageInfo.hasNextPage && allPRs.length < count) {
        const resp2: RespPRs = await octokit.graphql(latest_merged_prs, { org: `https://github.com/${owner}`, repo, cursor: pageInfo.endCursor });
        pageInfo = resp2.resource.repository.pullRequests.pageInfo;

        for (const pr of resp2.resource.repository.pullRequests.nodes) {
            allPRs.push(pr);
        }
    }

    const validPRs = _(allPRs)
        .filter({ baseRefName: default_branch, isDraft: false, locked: false })
        .map(pr => load_pr(repo_info, pr))
        .filter(Boolean)
        .map(pr => pr as PullRequest)
        .filter(pr => whitelist.has(pr.number))
        .value();

    const graph = new DepGraph();

    for (const pr of validPRs) {
        graph.addNode(pr.permalink);
    }

    const crossRepoDeps: PRId[] = [];

    for (const pr of validPRs) {
        for (const dep of pr.dependencies) {
            const dep_permalink = stringify_pr(dep);
        
            if (!graph.hasNode(dep_permalink)) {
                graph.addNode(dep_permalink);
            }
        
            graph.addDependency(pr.permalink, dep_permalink);
        
            if (dep.repo_id.owner != "GTNewHorizons" || dep.repo_id.repo != repo) {
                crossRepoDeps.push(dep);
            }
        }
    }

    const order = graph.overallOrder();

    validPRs.sort(pr => order.indexOf(pr.permalink));

    return {
        prs: validPRs,
        dependencies: crossRepoDeps
    };
}

const PR_URL = /^https:\/\/github\.com\/(?<owner>[\w\d\-]+)\/(?<repo>[\w\d\-]+)\/pull\/(?<pr>\d+)$/;
const PR_SHORT = /^(?<owner>\w+)\/(?<repo>[\w\d\-]+)#(?<pr>\d+)$/;

export function parse_pr(pr: string): PRId | null {
    var matcher = PR_URL.exec(pr);

    if (!matcher || !matcher.groups) {
        matcher = PR_SHORT.exec(pr);
    }

    if (!matcher || !matcher.groups) return null;

    return {
        repo_id: {
            owner: matcher.groups["owner"],
            repo: matcher.groups["repo"]
        },
        pr: parseInt(matcher.groups["pr"]),
    };
}

export function stringify_pr(pr: PRId) {
    return `https://github.com/${pr.repo_id.owner}/${pr.repo_id.repo}/pull/${pr.pr}`;
}

export async function get_pr(pr_id: PRId) {
    try {
        const resp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner: pr_id.repo_id.owner,
            repo: pr_id.repo_id.repo,
            pull_number: pr_id.pr
        });

        return load_pr(pr_id.repo_id, {
            ...resp.data,
            id: ""+resp.data.id,
            labels: {
                nodes: _.map(resp.data.labels, l => ({ name: l.name }))
            },
            baseRefName: resp.data.base.ref,
            bodyText: resp.data.body || "",
            headRefName: resp.data.head.ref,
            isDraft: resp.data.draft || false,
            permalink: stringify_pr(pr_id),
            updatedAt: resp.data.updated_at
        });
    } catch (e) {
        logger.error(`Could not find PR ${stringify_pr(pr_id)}: ${e}`);
        return null;
    }
}
