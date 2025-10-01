import _ from "lodash";
import { GQList, NamedObject, octokit } from "./types";
import { logger } from "../entry_point";
import { DepGraph } from "dependency-graph";

export type BranchName = string;

/** ISO-8601 encoded date */
export type DateString = string;

export type ReviewDecision = "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED" | null;

export type PRDependency = string;

export type PullRequest = {
    labels: {
        nodes: Array<{ name: string }>
    },
    baseRefName: BranchName,
    bodyText: string,
    databaseId: number,
    headRefName: BranchName,
    id: string,
    isDraft: boolean,
    isInMergeQueue: boolean,
    locked: boolean,
    /** PR number */
    number: number,
    /** PR browser link */
    permalink: string,
    reviewDecision: ReviewDecision,
    title: string,
    updatedAt: string,
    dependencies: PRDependency[],
};

type Q = {
    resource: {
        repository: {
            pullRequests: GQList<PullRequest>
        }
    }
};

const query = `
query($repo: String!, $cursor: String) {
    resource(url: "https://github.com/GTNewHorizons/") {
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
                        databaseId
                        headRefName
                        id
                        isDraft
                        isInMergeQueue
                        locked
                        number
                        permalink
                        reviewDecision
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

/** PR cannot be reverted and the experimental must be cancelled if the PR could not be included after it was previously included */
export const NOT_REVERTABLE = "Not Revertable";

export const NEWLINE = /[\n\r]+/;
const PR_HASH = /^#(?<pr>\d+)$/;

export type PRInfo = {
    prs: PullRequest[];
    dependencies: PRId[];
}

export async function get_prs(repo: string): Promise<PRInfo> {

    const resp: Q = await octokit.graphql(query, { repo, cursor: null });

    const allPRs = [...resp.resource.repository.pullRequests.nodes];

    var pageInfo = resp.resource.repository.pullRequests.pageInfo;

    while (pageInfo.hasNextPage) {
        const resp2: Q = await octokit.graphql(query, { repo, cursor: pageInfo.endCursor });
        pageInfo = resp2.resource.repository.pullRequests.pageInfo;

        for (const pr of resp2.resource.repository.pullRequests.nodes) {
            allPRs.push(pr);
        }
    }

    const validPRs = _.filter(allPRs, {baseRefName: "master", isDraft: false, isInMergeQueue: false, locked: false});

    for (const pr of validPRs) {
        for (const label of pr.labels.nodes) {
            label.name = label.name.toLowerCase();
        }
    }

    _.remove(validPRs, pr => {
        for (const label of pr.labels.nodes) {
            if (_.includes(BLOCKER_LABELS, label.name)) {
                return true;
            }
        }

        return false;
    });

    const graph = new DepGraph();

    for (const pr of validPRs) {
        graph.addNode(pr.permalink);
    }

    const crossRepoDeps: PRId[] = [];

    const invalidPRs: string[] = [];

    outer:
    for (const pr of validPRs) {
        const lines = pr.bodyText.split(NEWLINE);

        pr.dependencies = [];

        for (const line of lines) {
            if (!line.startsWith("depends on:")) continue;

            var dep = line.replace("depends on:", "").trim();

            const hash = PR_HASH.exec(dep);

            if (hash && hash.groups) {
                dep = stringify_pr({
                    group: "GTNewHorizons",
                    repo,
                    pr: parseInt(hash.groups["pr"])
                });
            }

            const pr_id = parse_pr(dep);

            if (!pr_id) {
                logger.error(`PR ${pr.permalink} depends on invalid PR ${dep}: it will be removed from this release`);
                invalidPRs.push(pr.permalink);
                continue outer;
            }

            if (!graph.hasNode(dep)) {
                graph.addNode(dep);
            }

            graph.addDependency(pr.permalink, dep);

            pr.dependencies.push(line.trim());

            if (pr_id.group != "GTNewHorizons" || pr_id.repo != repo) {
                crossRepoDeps.push(pr_id);
            }
        }
    }

    _.forEach(invalidPRs, pr => _.remove(validPRs));

    const order = graph.overallOrder();

    validPRs.sort(pr => order.indexOf(pr.permalink));

    return {
        prs: validPRs,
        dependencies: crossRepoDeps
    };
}

const PR_URL = /^https:\/\/github\.com\/(?<group>[\w\d\-]+)\/(?<repo>[\w\d\-]+)\/pull\/(?<pr>\d+)$/;
const PR_SHORT = /^(?<group>\w+)\/(?<repo>[\w\d\-]+)#(?<pr>\d+)$/;

export type PRId = {
    group: string;
    repo: string;
    pr: number;
};

export function parse_pr(pr: string): PRId | null {
    var matcher = PR_URL.exec(pr);

    if (!matcher || !matcher.groups) {
        matcher = PR_SHORT.exec(pr);
    }

    if (!matcher || !matcher.groups) return null;

    return {
        group: matcher.groups["group"],
        repo: matcher.groups["repo"],
        pr: parseInt(matcher.groups["pr"]),
    };
}

export function stringify_pr(pr: PRId) {
    return `https://github.com/${pr.group}/${pr.repo}/pull/${pr.pr}`;
}

export async function get_pr(pr: PRId) {
    try {
        return (await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner: pr.group,
            repo: pr.repo,
            pull_number: pr.pr
        })).data;
    } catch (e) {
        logger.error(`Could not find PR ${stringify_pr(pr)}: ${e}`);
        return null;
    }
}
