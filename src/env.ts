import dotenv from 'dotenv';

dotenv.config({ quiet: process.env.NODE_ENV === 'production' });

export const prod: boolean = process.env.NODE_ENV === "production";
export const gh_token: string = process.env.GH_TOKEN as string;
export const clone_scratchpad: string = process.env.CLONE_SCRATCHPAD as string;

export const dev_branch = "dev-mmxxl";
export const dev_custom = dev_branch + "-custom";
export const dev_error = dev_branch + "-error";
export const mergiraf = true;

export const mmxxl_blacklist = [
    "GTNewHorizons/Angelica",
];

export const spotless_blacklist = [
    "GTNewHorizons/Et-Futurum-Requiem",
    "GTNewHorizons/spark",
];

export const update_deps_blacklist = [
    "GTNewHorizons/Et-Futurum-Requiem",
    "GTNewHorizons/spark",
];
