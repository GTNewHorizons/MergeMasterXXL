import _ from "lodash";
import { octokit } from "./types";
import { dryrun, logger } from "../entry_point";
import { Commit } from "./repos";
import yaml from "yaml";

export async function get_branch_update_time(repo: string, branch: string): Promise<Date | null> {
    try {
        const resp = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
            owner: "GTNewHorizons",
            repo,
            branch,
        });
    
        const date = _.get(resp.data.commit.committer || resp.data.commit.commit.author, "date");
    
        return date && new Date(date) || null;
    } catch (e) {
        logger.info(`Could not get branch update time for '${branch}': ${e}`);
        return null;
    }
}

export async function delete_dev(repo: string) {
    if (dryrun) return;

    await octokit.request("DELETE /repos/{owner}/{repo}/branches/{branch}", {
        owner: "GTNewHorizons",
        repo,
        branch: "dev",
    });
}

export async function get_branch_commits(repo: string, branch: string): Promise<Commit[]> {
    const result = await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: "GTNewHorizons",
        repo,
        sha: branch,
        per_page: 5,
    });

    return _.map(result.data, commit => ({
        commit: commit.sha,
        author_name: commit.author?.name,
        author_email: commit.author?.email,
        author_date: (commit.author as any)?.date,
        committer_name: commit.committer?.name,
        committer_email: commit.committer?.email,
        committer_date: (commit.committer as any)?.date,
        subject: commit.commit.message,
        message: "",
    } as Commit));
}

export type DevBranchStatus = {
    ["Included PRs"]: string[];
    ["Removed PRs"]: string[];
    ["Dependencies"]: string[];
};

export function get_dev_branch_status(commits: Commit[]): DevBranchStatus | null {
    // Scan the last few commits because we might have added a dep update commit after the status commit
    for (const commit of commits) {
        if (commit && commit.committer_name == "MergeMasterXXL" && commit.subject == "Dev Branch Status") {
            try {
                return yaml.parse(commit.message);
            } catch (e) {
                logger.error(`Could not parse Dev Branch Status commit: ${e}`);
                return null;
            }
        }
    }

    return null;
}
