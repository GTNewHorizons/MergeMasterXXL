import dotenv from 'dotenv';

dotenv.config({ quiet: process.env.NODE_ENV === 'production' });

export const prod: boolean = process.env.NODE_ENV === "production";
export const gh_token: string = process.env.GH_TOKEN as string;
export const clone_scratchpad: string = process.env.CLONE_SCRATCHPAD as string;
