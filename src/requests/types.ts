import { Octokit } from "@octokit/core";
import { gh_token } from "../env";

export const octokit = new Octokit({ auth: gh_token });

export type NamedObject = {
    databaseId: number;
    id: string;
    login: string;
    name?: string;
};

export type PageInfo = {
    endCursor: string;
    hasNextPage: boolean;
};

export type GQList<T> = {
    totalCount: number;
    nodes: T[];
    pageInfo: PageInfo;
};
