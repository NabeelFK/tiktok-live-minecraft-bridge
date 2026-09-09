/**
 * env.ts - configuration, resolved once, in one place.
 *
 * `.env` is loaded HERE, at the top of this module, before any value is read out of
 * it. Every other file gets its configuration by importing from this module instead
 * of touching `process.env` directly, and that is what makes the loading safe:
 * whichever module happens to load first, this one has already run by the time
 * anything can read a value. No import-order trap, and no rule about which import
 * has to come first in bridge.ts.
 *
 * PRECEDENCE: a variable already set in the real environment WINS over `.env`.
 * dotenv never overwrites an existing variable, so
 *
 *   $env:MC_PLAYER = "SomeoneElse"      # PowerShell
 *   npx tsx bridge.ts --test
 *
 * overrides the file for one run without editing it, which is what you want while
 * debugging. Nothing here can silently replace a value you set deliberately.
 *
 * WHERE IT LOOKS, in order:
 *   1. `.env` beside these source files, i.e. the repo root. This is the documented
 *      location and the one .env.example tells you to create.
 *   2. `.env` in the directory the command was run from, if that is somewhere else.
 * The first file to define a variable wins, for the same no-overwrite reason.
 * Missing files are not an error: setting everything in the shell is still valid.
 */

import path from 'node:path';
import { config } from 'dotenv';

const REPO_ENV = path.join(__dirname, '.env');
const CWD_ENV = path.resolve(process.cwd(), '.env');

const candidates = CWD_ENV === REPO_ENV ? [REPO_ENV] : [REPO_ENV, CWD_ENV];
const loaded: string[] = [];

for (const file of candidates) {
  // quiet: true, or dotenv prints a banner into the output of every run, including
  // the check modes whose output is meant to be read.
  const result = config({ path: file, quiet: true });
  if (!result.error) loaded.push(file);
}

/** The .env files that were actually read. Empty when there is no .env anywhere. */
export const ENV_FILES: readonly string[] = loaded;

const read = (name: string) => (process.env[name] ?? '').trim();

/** Exact in-game name, case sensitive. Every command targets this player. */
export const MC_PLAYER = read('MC_PLAYER');

/** TikTok handle, no @. Live mode only; --user <name> overrides it. */
export const TIKTOK_USER = read('TIKTOK_USER');

/** rcon.password from the server's server.properties. */
export const RCON_PASSWORD = read('RCON_PASSWORD');

/** Euler Stream signing key. Optional: blank means free community rate limits. */
export const EULER_API_KEY = read('EULER_API_KEY');

/**
 * One line for an error message saying where configuration was read from. A missing
 * variable and an empty variable in a .env that WAS found are different problems and
 * want different fixes, so the message distinguishes them.
 */
export function envSourceHint(): string {
  return ENV_FILES.length
    ? `Read ${ENV_FILES.join(' and ')}, so check that the variable is filled in there.`
    : 'No .env file was found. Copy .env.example to .env in the repo root and fill it in,' +
      ' or set the variable in your shell.';
}
