import _ from "lodash";
import { octokit } from "./types";
import { dryrun, logger } from "../entry_point";
import { Commit, COMMIT_PR, parse_repo_id, RepoId } from "./repos";
import yaml from "yaml";
import { NEWLINE } from "./prs";
import { dev_branch } from "../env";

export async function get_branch_update_time(repo_id: RepoId, branch: string): Promise<Date | null> {
    try {
        const { owner, repo } = parse_repo_id(repo_id);

        const resp = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
            owner,
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

export async function delete_dev(repo_id: RepoId) {
    if (dryrun) return;

    const { owner, repo } = parse_repo_id(repo_id);

    await octokit.request("DELETE /repos/{owner}/{repo}/branches/{branch}", {
        owner,
        repo,
        branch: dev_branch,
    });
}

export async function get_branch_commits(repo_id: RepoId, branch: string): Promise<Commit[]> {
    try {
        const { owner, repo } = parse_repo_id(repo_id);
    
        const result = await octokit.request("GET /repos/{owner}/{repo}/commits", {
            owner,
            repo,
            sha: branch,
            per_page: 5,
        });
    
        return _.map(result.data, commit => {
            
            const lines = commit.commit.message.split(NEWLINE);

            var subject = lines[0];
            
            const match = COMMIT_PR.exec(subject);

            var prid: number | null = null;

            if (match && match.groups) {
                prid = parseInt(match.groups["pr"]);

                subject = subject.slice(0, subject.length - match.groups["pr"].length);
            }

            return {
                commit: commit.sha,
                author_name: commit.commit.author?.name,
                author_email: commit.commit.author?.email,
                author_date: (commit.commit.author as any)?.date,
                committer_name: commit.commit.committer?.name,
                committer_email: commit.commit.committer?.email,
                committer_date: (commit.commit.committer as any)?.date,
                prid,
                subject,
                message: lines.slice(1).join("\n").trim(),
            } as Commit;
        });
    } catch (e) {
        logger.info(`Could not get commits for ${repo_id}:${branch}: ${e}`);
        return [];
    }
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
