import _ from "lodash";
import { octokit } from "./types";
import { dryrun } from "../entry_point";

export async function get_branch_update_time(repo: string, branch: string): Promise<Date | null> {
    const resp = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
        owner: "GTNewHorizons",
        repo,
        branch,
    });

    octokit.request('GET /repos/{owner}/{repo}/commits/{ref}')

    if ((resp as any).status == 404) return null;

    const date = _.get(resp.data.commit.committer || resp.data.commit.author, "date");

    return date || null;
}

export async function delete_dev(repo: string) {
    if (dryrun) return;

    await octokit.request("DELETE /repos/{owner}/{repo}/branches/{branch}", {
        owner: "GTNewHorizons",
        repo,
        branch: "dev",
    });
}
