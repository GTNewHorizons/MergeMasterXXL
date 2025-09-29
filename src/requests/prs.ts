import _ from "lodash";
import { GQList, NamedObject, octokit } from "./types";

export type BranchName = string;

/** ISO-8601 encoded date */
export type DateString = string;

export type ReviewDecision = "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED" | null;

export type PRDependency = {
    repo: string;
    pr: number;
};

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

const BLOCKER_LABELS = ["Affects Balance", "Not Ready for Testing"];

/** PR cannot be reverted and the experimental must be cancelled if the PR could not be included after it was previously included */
export const NOT_REVERTABLE = "Not Revertable";

const NEWLINE = /[\n\r]+/;
const DEPENDENCY = /(depends on\:)\s+(https\:\/\/github.com\/GTNewHorizons)?(?<repo>\\w+)\/(?<pr>\\d+)/;

export type PRInfo = {
    prs: PullRequest[];
    dependencies: PRDependency[];
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

    _.remove(validPRs, pr => {
        for (const label of pr.labels.nodes) {
            if (_.find(BLOCKER_LABELS, label.name)) {
                return true;
            }
        }

        return false;
    });

    const allDeps: PRDependency[] = [];

    for (const pr of validPRs) {
        const lines = pr.bodyText.split(NEWLINE);

        pr.dependencies = [];

        for (const line of lines) {
            const match = DEPENDENCY.exec(line);

            if (!match || !match.groups) continue;

            const dep = {
                repo: match.groups["repo"],
                pr: Number(match.groups["pr"]),
            };

            pr.dependencies.push(dep);
            allDeps.push(dep);
        }
    }

    _.sortBy(validPRs, "number");

    return {
        prs: validPRs,
        dependencies: allDeps
    };
}
