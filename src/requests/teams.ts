import { GQList, NamedObject, octokit } from "./types";

export type User = NamedObject & {

};

export type Team = NamedObject & {
    members: GQList<User>,
};

type Q1 = {
    organization: NamedObject & {
        teams: GQList<Team>
    }
};

const first_query = `
query {
    organization(login: "GTNewHorizons") {
        id
        login
        name
        teams(first: 10) {
            totalCount
            nodes {
                databaseId
                members(first: 100) {
                    nodes {
                        databaseId
                        id
                        login
                    }
                    pageInfo {
                        endCursor
                        hasNextPage
                    }
                    totalCount
                }
                id
                name
            }
        }
    }
}`;

type Q2 = {
    organization: NamedObject & {
        team: Team
    }
};

const addl_query = `
query($team: String!, $cursor: String!) {
    organization(login: "GTNewHorizons") {
        id
        login
        name
        team(slug: $team) {
                databaseId
                members(after: $cursor) {
                    nodes {
                        databaseId
                        id
                        login
                    }
                    pageInfo {
                        endCursor
                        hasNextPage
                    }
                    totalCount
                }
                id
                name
        }
    }
}`;

export async function get_members(): Promise<{[databaseId: number]: User}> {
    const members = {};

    return members;

    const resp: Q1 = await octokit.graphql(first_query);

    for (var team of resp.organization.teams.nodes) {
        for (const member of team.members.nodes) {
            members[member.databaseId] = member;
        }

        while (team != null && team.members.pageInfo.hasNextPage) {
            const resp: Q2 = await octokit.graphql(addl_query, {
                team: team.name,
                cursor: team.members.pageInfo.endCursor
            });

            for (const member of resp.organization.team.members.nodes) {
                members[member.databaseId] = member;
            }

            team = resp.organization.team;
        }
    }

    return members;
}
