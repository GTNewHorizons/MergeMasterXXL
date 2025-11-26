import { ArgumentParser } from 'argparse';
import dotenv from 'dotenv';
import pino, { Logger } from 'pino';
import { argv } from 'process';
import { get_entry_point } from './entry_point';
import fs from "fs";
import path from 'path';

dotenv.config({ quiet: process.env.NODE_ENV === 'production' });

const parser = new ArgumentParser({ description: 'Merge tool for GT: New Horizons.' });

parser.add_argument('--token', {
    dest: "token",
    help: 'Github token override. Takes priority over the env var GH_TOKEN if set.',
});
parser.add_argument('--scratchpad', {
    dest: "scratchpad",
    help: 'The folder to put repo clones in. Should not contain any other files - MMXXL will remove clones. Takes priority over the env var CLONE_SCRATCHPAD if set.',
});
parser.add_argument('--dev-branch', {
    dest: "dev_branch",
    help: 'The dev branch name override.',
});
parser.add_argument('--dev-custom', {
    dest: "dev_custom",
    help: 'The custom dev branch name override. Used for adding extra changes into dev that aren\'t from a PR.',
});
parser.add_argument('--dev-error', {
    dest: "dev_error",
    help: 'The error dev branch name override. The latest dev branch will be pushed to this branch when a merge conflict occurs.',
});
parser.add_argument('--dryrun', {
    dest: "dryrun",
    action: "store_true",
    help: 'Performs every operation as normal, but does not push anything.'
});
parser.add_argument('--log-level', {
    dest: "log_level",
    help: 'Sets the log level. One of: trace, debug, info, warn, error, fatal.'
});
parser.add_argument('--mmxxl-blacklist', {
    dest: "mmxxl_blacklist",
    action: 'append',
    help: 'Adds a repo to the MMXXL blacklist. No operations will be performed on the given repos.',
});
parser.add_argument('--spotless-blacklist', {
    dest: "spotless_blacklist",
    action: 'append',
    help: 'Adds a repo to the spotless blacklist. Spotless will not be ran on the given repos.',
});
parser.add_argument('--update-deps-blacklist', {
    dest: "update_deps_blacklist",
    action: 'append',
    help: 'Adds a repo to the updates blacklist. Dependencies will not be updated on the given repos, even if they have inter-repo dependencies.',
});

if (argv[1].endsWith("tag_dev.ts")) {
    parser.add_argument('repos', {
        type: 'string',
        nargs: '*',
        help: 'A list of repos to tag (each in the format `Owner/Repo`: `GTNewHorizons/GT5-Unofficial`)'
    });
}

const args = parser.parse_args();

export const prod: boolean = process.env.NODE_ENV === "production";
export const gh_token: string = (args.token || process.env.GH_TOKEN) as string;
export const clone_scratchpad: string = (args.scratchpad || process.env.CLONE_SCRATCHPAD || path.resolve(process.cwd(), "clones")) as string;

export const dev_branch = args.dev_branch || "dev-mmxxl";
export const dev_custom = args.dev_custom || (dev_branch + "-custom");
export const dev_error = args.dev_error || (dev_branch + "-error");
export const dryrun = args.dryrun;

export const repos: string[] = args.repos || [];

export const logger: Logger = prod ?
    pino({ transport: { target: "pino-pretty", options: { colorize: false, }, }, level: args.log_level || "debug" }) :
    pino({ transport: { target: "pino-pretty", options: { colorize: true, }, }, level: args.log_level || "debug" });

export const mmxxl_blacklist = [
    "GTNewHorizons/Angelica",
    ...(args.mmxxl_blacklist || []),
];

export const spotless_blacklist = [
    "GTNewHorizons/Et-Futurum-Requiem",
    "GTNewHorizons/spark",
    ...(args.spotless_blacklist || []),
];

export const update_deps_blacklist = [
    "GTNewHorizons/Et-Futurum-Requiem",
    "GTNewHorizons/spark",
    "GTNewHorizons/Hodgepodge",
    ...(args.update_deps_blacklist || []),
];
