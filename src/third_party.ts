import _ from "lodash";
import { parse_pr, PRId } from "./requests/prs";
import { RepoId } from "./requests/repos";

const third_party_prs: {[repo_id: RepoId]: string[]} = {
    "GTNewHorizons/spark": [
        "https://github.com/lucko/spark/pull/495",
        "https://github.com/GTNewHorizons/spark/pull/3"
    ]
};

export function get_third_party_prs(repo_id: RepoId): PRId[] {
    return _(third_party_prs[repo_id])
        .map(parse_pr)
        .filter(Boolean)
        .map(x => x as PRId)
        .value();
}
