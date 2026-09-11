/**
 * TikTok LIVE -> Minecraft bridge
 *
 * Modes:
 *   npx tsx bridge.ts --test              Type gift names by hand. No TikTok. Tests the Minecraft half.
 *   npx tsx bridge.ts --spy <user>        Watch someone's live, log gifts, record them to a .jsonl. No Minecraft.
 *   npx tsx bridge.ts --replay <file>     Feed recorded payloads through the real live handler. Exercises the live path offline.
 *   npx tsx bridge.ts --verify            Syntax-check every mapped command against the server. Runs nothing.
 *   npx tsx bridge.ts --keys              Check every map key against the saved gift catalog. No server needed.
 *   npx tsx bridge.ts                     Live mode. Both halves connected.
 *
 * Flags (any mode):
 *   --dry            Log commands instead of sending them. Works with --replay to test with no server.
 *   --user <name>    Override TIKTOK_USER for live mode.
 *
 * Configuration comes from the environment - MC_PLAYER, TIKTOK_USER, RCON_PASSWORD and
 * EULER_API_KEY. Copy .env.example and fill it in; docs/SETUP.md is the walkthrough.
 *
 * Gifts, follows and likes all land here. Likes are counted from the room's running
 * total and every LIKES_PER_CREEPER of them spawns a creeper; see the likes section.
 *
 * This file is the engine. Which gift does what lives in gift-map.ts, and the builders
 * that map is written in live in gift-helpers.ts. Customising the show means editing
 * gift-map.ts and running `--keys`; it does not mean reading this file.
 */

import { Rcon } from 'rcon-client';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { EULER_API_KEY, RCON_PASSWORD, TIKTOK_USER, envSourceHint } from './env';
import { ASSUMED_COINS, GIFTS, PRICED, fallback } from './gift-map';
import {
  MC_PLAYER,
  at,
  banner,
  installScheduler,
  key,
  type Deferred,
  type PricedVariant,
} from './gift-helpers';

// ---------- config ----------
// Nothing identifying lives in this file. The four things that are yours - your
// TikTok handle, your in-game name, your RCON password and your Euler Stream key -
// come from env.ts, which reads them from .env and from the shell environment.
// See .env.example for the list and docs/SETUP.md for how to fill it in.
//
// MC_PLAYER is imported by gift-helpers.ts rather than here, because the gift map
// interpolates it into nearly every command it builds.

const RCON = { host: '127.0.0.1', port: 25575, password: RCON_PASSWORD, timeout: 5000 };

const CMDS_PER_SEC = 15;       // commands drained per second. 15 not 8: with MAX_QUEUE at 120,
                               // draining at 8/s meant a full queue was 15s of lag between gift and effect.
const MAX_QUEUE = 120;         // hard backlog cap, anything past this is dropped.
                               // Sized in SECONDS, not commands: 120 at 15/s is ~8s of
                               // worst-case lag between a gift and its effect.
const CMD_TTL_MS = 45_000;     // a queued command older than this is stale, drop it rather than fire it late
const MAX_CMD_ATTEMPTS = 3;    // per-command retries across reconnects before giving up on it

const RCON_BACKOFF_MIN = 1_000;
const RCON_BACKOFF_MAX = 15_000;   // a Paper restart is short, don't sit out half a minute after it's back
const TT_BACKOFF_MIN = 5_000;
const TT_BACKOFF_MAX = 300_000;  // sign requests are metered, so back off hard

const DRY = process.argv.includes('--dry');
const VERIFY = process.argv.includes('--verify');

// nicknames are user-controlled and go straight into a server command.
// strip anything that isn't safe to interpolate. same for gift names off the wire.
//
// The allowlist is letters, digits, underscore, space, dot and hyphen. Everything else
// goes, which covers the two that matter - `"` and `\` would break out of the tellraw
// JSON - plus control characters, RTL and zero-width marks, emoji and the section sign.
//
// Trimming is by CODE POINT, not by UTF-16 unit: cutting at 24 units can land in the
// middle of a surrogate pair and emit half a character.
export function sanitize(s: string): string {
  const clean = s.replace(/[^\p{L}\p{N}_ .-]/gu, '').trim();
  return [...clean].slice(0, 24).join('') || 'someone';
}

// Paths printed for humans. An absolute path here means the console (and anything
// screen-shared while streaming) shows the operator's home directory and username.
const shortPath = (p: string) => {
  const rel = path.relative(process.cwd(), p);
  return !rel || rel.startsWith('..') ? path.basename(p) : rel;
};

/** Highest-priced variant this gift can afford, or undefined if it affords none. */
const pickVariant = (variants: PricedVariant[], unitCoins: number) =>
  [...variants].sort((a, b) => b.minCoins - a.minCoins).find((v) => unitCoins >= v.minCoins);

export function resolve(giftName: string, repeatCount: number, diamonds: number): string[] {
  const k = key(giftName);
  const n = Math.max(repeatCount, 1);

  const variants = PRICED[k];
  if (variants) {
    const hit = pickVariant(variants, diamonds);
    if (!hit) return fallback(diamonds * n);
    return (hit.action ?? GIFTS[k])(n);
  }

  const action = GIFTS[k];
  return action ? action(n) : fallback(diamonds * n);
}

/** How resolve() decided, for the console line. Kept next to resolve so they cannot drift. */
function resolutionLabel(giftName: string, repeatCount: number, diamonds: number): string {
  const k = key(giftName);
  const n = Math.max(repeatCount, 1);
  const total = diamonds * n;
  const variants = PRICED[k];
  if (variants) {
    const hit = pickVariant(variants, diamonds);
    return hit ? `mapped, priced >=${hit.minCoins}` : `priced miss at ${diamonds}c -> fallback ${total}c`;
  }
  return GIFTS[k] ? 'mapped' : `fallback ${total}c`;
}

// ---------- rate-limited command queue with a self-healing RCON link ----------

type Job = { cmd: string; expiresAt: number; attempts: number };

const queue: Job[] = [];
let rcon: Rcon | null = null;
let linkState: 'down' | 'connecting' | 'up' = 'down';
let rconAttempt = 0;
let retryScheduled = false;
let shuttingDown = false;
let dropWarned = false;
let stats = { sent: 0, expired: 0, dropped: 0, reconnects: 0, rejected: 0 };

// Minecraft answers a bad command with error TEXT over RCON, it does not reject the
// promise. Ignoring the reply is how a typo'd command silently does nothing all stream.
// Dedupe by the first three tokens so one bad gift doesn't spam the console.
const seenBadCmds = new Set<string>();
function checkReply(cmd: string, reply: string) {
  const r = (reply ?? '').trim();
  if (!r) return;
  if (!/^(Unknown|Incorrect|Expected|Invalid|Unable|Could not|Failed|No \w+ (were|was) found|That player)/i.test(r)
      && !r.includes('<--[HERE]')) return;
  stats.rejected++;
  const head = cmd.split(' ').slice(0, 3).join(' ');
  if (seenBadCmds.has(head)) return;
  seenBadCmds.add(head);
  console.error(`[cmd] server rejected: ${cmd}`);
  console.error(`      -> ${r.slice(0, 200)}`);
  // The server can only say "no player was found"; it cannot say "your MC_PLAYER is
  // wrong". That is the first-run failure this rejection almost always means, and
  // without the hint it looks like a broken command rather than a typo in your name.
  if (/No \w+ (were|was) found|That player/i.test(r)) {
    console.error(`      MC_PLAYER is currently "${MC_PLAYER}". It must match your in-game name exactly,`);
    console.error('      including capitalisation, and you must be joined to the server.');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number, min: number, max: number) =>
  Math.min(max, min * 2 ** attempt) * (0.75 + Math.random() * 0.5);

function enqueue(cmds: string[]) {
  const expiresAt = Date.now() + CMD_TTL_MS;
  for (const cmd of cmds) {
    if (queue.length >= MAX_QUEUE) {
      stats.dropped++;
      if (!dropWarned) {
        console.warn(`[queue] full at ${MAX_QUEUE}, dropping the rest`);
        dropWarned = true;
      }
      return;
    }
    queue.push({ cmd, expiresAt, attempts: 0 });
  }
  dropWarned = false;
}

// ---------- which scheduler the gift map gets ----------
// later() in gift-helpers.ts is a hole the engine fills, exactly once, here.
// A normal run schedules a real timer. --verify collects the payloads instead, so
// verifyMode can syntax-check the delayed stages of a gift in the same pass as its
// immediate commands.
//
// Installed at module load, before any mode can run an action, so a gift can never
// reach later() before a scheduler exists. If one ever did, later() throws rather
// than quietly dropping the commands.
const deferredCollected: Deferred[] = [];

// A gift is not finished when its first commands go out. BURIED seals the pit 2.5s
// after it opens it, and THE FINALE runs for nine seconds across five stages. Each
// pending stage is a promise the bridge has made and not yet kept, so they are
// tracked rather than left to anonymous timers: code that shuts down without knowing
// what is outstanding drops it silently, and silent loss is the failure this project
// keeps finding. One later() call is one stage, however many commands it carries.
type PendingStage = { firesAt: number; commands: number; timer: NodeJS.Timeout };
const pendingStages = new Set<PendingStage>();

export function scheduleStage(ms: number, cmds: string[]) {
  const stage: PendingStage = {
    firesAt: Date.now() + ms,
    commands: cmds.length,
    timer: setTimeout(() => {
      pendingStages.delete(stage);
      if (!shuttingDown) enqueue(cmds);
    }, ms),
  };
  pendingStages.add(stage);
}

/** Cancel every outstanding stage. Called on shutdown, after saying what is being lost. */
export function cancelPendingStages() {
  for (const stage of pendingStages) clearTimeout(stage.timer);
  pendingStages.clear();
}

/** What is still owed: how many stages, how many commands, how far off the last one is. */
export function pendingStageSummary() {
  const now = Date.now();
  let commands = 0;
  let longestMs = 0;
  for (const stage of pendingStages) {
    commands += stage.commands;
    longestMs = Math.max(longestMs, stage.firesAt - now);
  }
  return { stages: pendingStages.size, commands, longestMs: Math.max(0, longestMs) };
}

installScheduler(
  VERIFY
    ? (ms, cmds) => { for (const cmd of cmds) deferredCollected.push({ ms, cmd }); }
    : scheduleStage,
);

/**
 * Wait for everything already promised to actually happen: the queue to drain, and
 * every delayed stage to fire and then drain in its turn.
 *
 * It says what it is waiting for. A ten-second silence at the end of a run reads as a
 * hang; "waiting for 5 delayed stages, 48 commands, last one 9.0s away" reads as the
 * finale finishing.
 *
 * Returns whatever is STILL outstanding if it gives up, so the caller can say so out
 * loud instead of exiting quietly. The cap matters when the link is down: with no
 * server to drain into, the queue never empties and this would otherwise wait forever.
 */
async function settle(tag: string, capMs = 30_000) {
  const giveUpAt = Date.now() + capMs;
  let lastReport = 0;

  for (;;) {
    const pending = pendingStageSummary();
    if (!queue.length && pending.stages === 0) break;
    if (Date.now() >= giveUpAt) break;

    if (pending.stages > 0 && Date.now() - lastReport >= 2_500) {
      lastReport = Date.now();
      console.log(
        `[${tag}] waiting for ${pending.stages} delayed stage(s), ${pending.commands} command(s),` +
        ` last one ${(pending.longestMs / 1000).toFixed(1)}s away`,
      );
    }
    await sleep(200);
  }

  // The drain loop takes a batch off the queue BEFORE it sends it, so an empty queue
  // is not the same as an idle link. Give the last batch a moment to finish landing.
  await sleep(1_000);

  // Two ways work can still be outstanding, and both are worth saying out loud: stages
  // that never fired, and commands that fired but never reached a server because the
  // link was down for the whole wait.
  return { ...pendingStageSummary(), queued: queue.length };
}

// Drain whatever the last action() call registered through later(). Draining per
// action is what keeps each delayed command labelled with the gift it came from.
const takeDeferred = (): Deferred[] => deferredCollected.splice(0);

/** Tear down the current link and let the reconnect loop pick it back up. */
function markDown(reason: string, instance?: Rcon | null) {
  if (shuttingDown) return;
  if (instance && instance !== rcon) return;   // stale event from a link we already replaced
  if (linkState === 'down' || linkState === 'connecting') return;
  console.warn(`[rcon] link lost (${reason}), reconnecting`);
  const dead = rcon;
  rcon = null;
  linkState = 'down';
  stats.reconnects++;
  dead?.end().catch(() => {});
}

/** Exactly one retry in flight at a time. Without this guard the drain loop and the
 *  timer each start their own chain and a long outage fans out into a dozen of them. */
function scheduleRconRetry() {
  if (retryScheduled || shuttingDown) return;
  retryScheduled = true;
  const wait = backoff(rconAttempt++, RCON_BACKOFF_MIN, RCON_BACKOFF_MAX);
  console.warn(`[rcon] retrying in ${Math.round(wait / 1000)}s`);
  setTimeout(() => { retryScheduled = false; void openRcon(); }, wait);
}

async function openRcon(): Promise<boolean> {
  if (shuttingDown || linkState !== 'down') return linkState === 'up';
  linkState = 'connecting';
  const next = new Rcon(RCON);
  // rcon-client emits 'error' on its own emitter. With no listener attached, node
  // rethrows it and kills the process. This listener is what keeps a Paper restart
  // from taking the bridge down with it.
  next.on('error', (err: any) => {
    console.error('[rcon] socket error:', err?.message ?? err);
    markDown('socket error', next);
  });
  next.on('end', () => markDown('socket closed', next));

  try {
    await next.connect();
    rcon = next;
    linkState = 'up';
    rconAttempt = 0;
    console.log(`[rcon] connected to ${RCON.host}:${RCON.port}`);
    return true;
  } catch (err) {
    linkState = 'down';
    await next.end().catch(() => {});
    console.warn(`[rcon] connect failed: ${(err as Error).message}`);
    scheduleRconRetry();
    return false;
  }
}

/** Single-flight drain. setInterval would let slow batches overlap and reorder commands. */
async function drainLoop() {
  while (!shuttingDown) {
    await sleep(1000);

    const now = Date.now();
    while (queue.length && queue[0].expiresAt <= now) { queue.shift(); stats.expired++; }

    if (linkState === 'down') { if (!retryScheduled) void openRcon(); continue; }
    if (linkState !== 'up' || !rcon) continue;
    if (!queue.length) continue;

    const batch = queue.splice(0, CMDS_PER_SEC);
    for (let i = 0; i < batch.length; i++) {
      const job = batch[i];
      try {
        const reply = await rcon.send(job.cmd);
        stats.sent++;
        checkReply(job.cmd, reply);
      } catch (err) {
        // Minecraft answers bad commands with text, it does not reject. A rejection here
        // means the link is gone or timed out, so put the work back and reconnect.
        job.attempts++;
        const survivors = batch.slice(i).filter((j) => j.attempts < MAX_CMD_ATTEMPTS && j.expiresAt > Date.now());
        stats.dropped += batch.slice(i).length - survivors.length;
        queue.unshift(...survivors);
        console.error('[rcon] send failed:', (err as Error).message);
        markDown('send failed', rcon);
        break;
      }
    }
  }
}

async function connectRcon() {
  if (DRY) {
    console.log('[rcon] --dry, commands will be logged not sent');
    void dryDrainLoop();
    return;
  }
  if (!RCON.password) {
    console.error('fatal: RCON_PASSWORD is not set. It is the rcon.password line in your');
    console.error("       server's server.properties.");
    console.error(envSourceHint());
    process.exit(1);
  }
  void drainLoop();
  const ok = await openRcon();
  if (!ok) console.warn('[rcon] not connected yet, queueing until the server answers');
}

async function dryDrainLoop() {
  while (!shuttingDown) {
    await sleep(1000);
    const batch = queue.splice(0, CMDS_PER_SEC);
    for (const job of batch) { console.log('  >', job.cmd); stats.sent++; }
  }
}

// ---------- follows ----------
// WebcastEvent.FOLLOW carries a WebcastSocialMessage: `user.nickname` and `user.id`,
// the same shape gifts use, so sanitize() applies unchanged.
//
// One guard, on identity rather than on rate: the same account re-following cannot
// farm repeat carrots. There is deliberately NO per-minute cap, so a raid of 200
// distinct accounts is 200 carrots. That is a real outcome to be aware of, not a bug:
// each one is a different person following for the first time, and the queue's own
// backlog cap is what stops it becoming unbounded lag.
const seenFollowers = new Set<string>();

function handleFollow(data: any, tag = 'follow') {
  const name = sanitize(data?.user?.nickname ?? 'someone');
  const id = String(data?.user?.id ?? name);

  if (seenFollowers.has(id)) {
    console.log(`[${tag}] ${name} already counted this session`);
    return;
  }
  seenFollowers.add(id);

  console.log(`[${tag}] ${name} -> golden carrot`);
  enqueue([banner(`NEW FOLLOWER ${name}`, 'green'), `give ${MC_PLAYER} golden_carrot 1`]);
}

// ---------- likes ----------
// WebcastEvent.LIKE carries a WebcastLikeMessage. Field paths here were READ from the
// installed packages, not assumed, because this project has been bitten by them moving
// before (docs/GOTCHAS.md):
//
//   tiktok-live-connector/dist/index-*.d.ts
//     LIKE = "like"  ->  EventHandler<WebcastLikeMessage>
//   tiktok-live-proto/dist/node/v3.d.ts
//     interface WebcastLikeMessage { count: number; total: string; user: User; ... }
//
// The connector emits it verbatim: "like" falls through the default branch of
// processDecodedData, so unlike gifts there is no enrichment and no renaming.
//
//   count  likes carried by THIS event. Likes batch - one event routinely carries
//          ten or more - so counting events instead of likes undercounts badly.
//   total  the room's running total for the stream, as a STRING (int64 in the proto).
//
// Both are present, so the running total does the counting and a local sum never does.
// A local sum resets on every reconnect and every restart, and a viewer who tapped
// ninety times would have to earn them again.
//
// NOTE: an older major of the proto called these `likeCount` and `totalLikeCount`
// (still visible in tiktok-live-proto/dist/node/v1.d.ts). If likes ever stop firing,
// that rename is the first thing to check with --spy.

// 500, not 100. There is no rate limit behind this, so the threshold is the only thing
// governing how often a creeper lands. At 100 a busy room satisfies it continuously and
// the number stops meaning anything; at 500 a milestone is an event that happens a few
// times an hour. It matters more here than for any other effect because a creeper is the
// only thing in the map that permanently changes the terrain: blindness wears off and
// gear can be re-got, but holes in the floor accumulate for the whole stream.
export const LIKES_PER_CREEPER = 500;

/**
 * How many `step` boundaries lie between two running totals.
 * Pure, so the burst case is testable without a stream.
 */
export function likeThresholdsCrossed(before: number, after: number, step = LIKES_PER_CREEPER): number {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (after <= before) return 0;
  return Math.floor(after / step) - Math.floor(before / step);
}

export type LikeDecision = {
  /** seed: first event, nothing owed. reset: total went backwards. none: no boundary. */
  kind: 'seed' | 'reset' | 'none' | 'creeper';
  /** the running total to carry forward */
  total: number;
  /** likes this event carried, after coercion */
  counted: number;
  /** false when the payload had no usable .total and the count had to be summed locally */
  usedTotal: boolean;
  /** boundaries this one event crossed. Can be >1; it still buys one creeper. */
  crossed: number;
  /** the highest boundary reached, for the banner */
  milestone: number;
};

/**
 * Decide what one like event is worth. All of the counting lives here and none of the
 * state does, so every branch is reachable from a test - including the wire shapes,
 * which is why this takes `unknown` and coerces rather than trusting the caller.
 * `total` arrives as a STRING off the wire (int64 in the proto).
 *
 * ONE creeper per event, however many thresholds that event crossed. A single payload
 * carrying 300 likes crosses three boundaries, and three creepers at once is not three
 * times the punishment - it is a guaranteed death and a crater, for an action nobody
 * paid for. `crossed` is still reported so the console can say what really happened.
 */
export function decideLike(
  prev: number | null,
  count: unknown,
  reportedTotal: unknown,
  step = LIKES_PER_CREEPER,
): LikeDecision {
  const counted = Math.max(0, num(count, 0));
  // NOT num() for the total. num() leans on Number(), and Number(null), Number('')
  // and Number([]) are all 0, so a MISSING total would read as "this stream has zero
  // likes" - which is below anything already counted, so every event would look like
  // a reset and the counter would never advance. A total is only a total if it
  // arrived as a number or as a non-empty numeric string, which is the wire shape.
  const asTotal =
    typeof reportedTotal === 'number' ? Math.trunc(reportedTotal)
    : typeof reportedTotal === 'string' && reportedTotal.trim() !== '' ? Math.trunc(Number(reportedTotal))
    : NaN;
  const usedTotal = Number.isFinite(asTotal) && asTotal >= 0;
  const total = usedTotal ? asTotal : (prev ?? 0) + counted;
  const base = { total, counted, usedTotal };

  if (prev !== null && total < prev) return { ...base, kind: 'reset', crossed: 0, milestone: 0 };

  // First event this session. Credit only the likes THIS event carried: a bridge
  // started when the room is already at 5,000 owes nothing for the 5,000 it never
  // saw, but the ten in this payload are real and were witnessed.
  const before = prev === null ? Math.max(0, total - counted) : prev;

  const crossed = likeThresholdsCrossed(before, total, step);
  if (crossed > 0) {
    return { ...base, kind: 'creeper', crossed, milestone: Math.floor(total / step) * step };
  }
  return { ...base, kind: prev === null ? 'seed' : 'none', crossed: 0, milestone: 0 };
}

/**
 * What a like milestone actually runs. One builder because --verify checks these
 * commands too, and a second copy of the literal is exactly how a verified command
 * and a fired command drift apart.
 */
export function likeCreeperCommands(milestone: number): string[] {
  return [
    banner(`${milestone} LIKES: CREEPER`, 'yellow'),
    at('summon creeper ~ ~ ~ {fuse:30}'),
  ];
}

let likeTotal: number | null = null;
let likeTotalWarned = false;

function handleLike(data: any, tag = 'like') {
  const name = sanitize(String(data?.user?.nickname ?? 'someone'));
  const first = likeTotal === null;
  const d = decideLike(likeTotal, data?.count, data?.total, LIKES_PER_CREEPER);
  likeTotal = d.total;

  if (!d.usedTotal && !likeTotalWarned) {
    likeTotalWarned = true;
    console.warn(`[${tag}] like payloads carry no usable .total, counting locally instead.`);
    console.warn('        A reconnect will reset that count. Run --spy and compare the');
    console.warn('        payload against docs/GOTCHAS.md - the field has moved before.');
  }

  if (first) console.log(`[${tag}] like total starts at ${d.total}, counting from here`);

  if (d.kind === 'reset') {
    console.log(`[${tag}] like total went backwards, treating ${d.total} as a new stream`);
    return;
  }
  if (d.kind !== 'creeper') return;

  const extra = d.crossed > 1 ? ` (${d.crossed} thresholds in one event, one creeper)` : '';
  console.log(`[${tag}] ${name} +${d.counted} -> ${d.total} likes, ${d.milestone} milestone${extra}`);
  enqueue(likeCreeperCommands(d.milestone));
}

// ---------- shared gift handler ----------
// Live mode and --replay both go through this. That is the point: --replay executes
// the exact code path a real gift takes, so live mode is not the only untested path.

// Everything off the wire is untrusted, in two different ways.
//
// Text is untrusted because a viewer chooses it: sanitize() handles that.
// NUMBERS are untrusted because the protocol is reverse-engineered and its field paths
// have moved between library versions before. A repeatCount that arrives as a string or
// an object makes Math.max() produce NaN, and NaN reaches `Array(NaN)` inside rep(),
// which throws RangeError. Thrown from inside a websocket event handler, that is an
// uncaught exception: the bridge dies in the middle of a stream because one payload was
// shaped oddly. Coerce here, once, and treat anything unusable as the safe default.
const num = (v: any, fallbackTo: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallbackTo;
};

// A gift with no name at all is the signature of the library's field paths moving under
// us: every gift would quietly resolve to fallback(1) and the show would degrade to a
// single TNT per gift with nothing in the log to say why. Say it once, loudly.
let namelessWarned = false;

function handleGift(data: any, tag = 'gift') {
  // v3 field paths, pinned from real --spy output.
  const name = String(data?.gift?.name ?? '');
  const diamonds = num(data?.gift?.diamondCount, 1);
  const giftType = data?.gift?.type;
  const repeatCount = Math.max(1, num(data?.repeatCount, 1));
  const sender = sanitize(String(data?.user?.nickname ?? data?.user?.displayId ?? 'someone'));

  if (!name && !namelessWarned) {
    namelessWarned = true;
    console.warn(`[${tag}] a gift payload had no gift.name. Every gift will fall through to`);
    console.warn('        the coin-value fallback until this is fixed. The library\'s field paths');
    console.warn('        have probably changed: run --spy and compare against docs/GOTCHAS.md.');
  }

  // streakable gifts (giftType 1) fire on every tick of the streak.
  // ignore until repeatEnd, or one rose spam becomes thirty triggers.
  if (giftType === 1 && data?.repeatEnd !== 1) return;

  const cmds = resolve(name, repeatCount, diamonds);
  const safeName = sanitize(name || 'a gift');
  const mapped = resolutionLabel(name, repeatCount, diamonds);
  console.log(`[${tag}] ${sender} sent ${safeName} x${repeatCount} (${mapped}) -> ${cmds.length} commands`);
  enqueue([`tellraw @a {"text":"${sender} sent ${safeName} x${repeatCount}","color":"gray"}`, ...cmds]);
}

/** Run a payload handler so a bad payload is logged and skipped, never fatal. */
function guard(what: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(`[${what}] payload handler failed, skipping it:`, (err as Error)?.message ?? err);
  }
}

// ---------- mode: --test ----------
// No TikTok at all. Type "rose 5" and it runs the same resolve/queue path a real gift takes.
// Add !<coins> to force the fallback tier, e.g.  "mystery gift 3 !1500"

let fakeLikeTotal = 0;

async function testMode() {
  await connectRcon();
  console.log('\nType: <gift name> [count] [!coins]   e.g.  rose 5     or    unknown thing !1500');
  console.log('Or:   follow <name>                  to test the follow reward and the per-account dedupe');
  console.log(`Or:   likes <n>                       to add n likes and cross the ${LIKES_PER_CREEPER}-like thresholds`);
  console.log('Known gifts:', Object.keys(GIFTS).join(', '));
  console.log('Anything else falls through to the coin-value fallback.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    let parts = line.trim().split(/\s+/);
    if (!parts[0]) return;

    // `follow <name>` exercises the follow path. Run it twice with the same name to
    // see the dedupe: the second one is ignored, because the id is derived from it.
    if (parts[0].toLowerCase() === 'follow') {
      const who = parts.slice(1).join(' ') || 'tester';
      handleFollow({ user: { nickname: who, id: `test:${who.toLowerCase()}` } }, 'test');
      return;
    }

    // `likes <n>` adds n to a running total and feeds a real-shaped payload through
    // handleLike, so the threshold crossing and the burst coalescing are both exercised
    // by hand. `total` is a string here because that is what the wire sends.
    if (parts[0].toLowerCase() === 'likes') {
      const n = Math.max(1, parseInt(parts[1] ?? '1', 10) || 1);
      fakeLikeTotal += n;
      handleLike({ count: n, total: String(fakeLikeTotal), user: { nickname: 'tester' } }, 'test');
      return;
    }

    let diamonds = 1;
    const coinArg = parts.find((p) => /^!\d+$/.test(p));
    if (coinArg) { diamonds = parseInt(coinArg.slice(1), 10); parts = parts.filter((p) => p !== coinArg); }

    const count = parseInt(parts[parts.length - 1], 10);
    const hasCount = !isNaN(count) && parts.length > 1;
    const name = (hasCount ? parts.slice(0, -1) : parts).join(' ');
    const n = hasCount ? count : 1;

    const cmds = resolve(name, n, diamonds);
    const mapped = resolutionLabel(name, n, diamonds);
    console.log(`[test] ${name} x${n} (${mapped}) -> ${cmds.length} commands`);
    enqueue(cmds);
  });
}

// ---------- mode: --spy <username> ----------
// Connect to any live streamer, dump gift payloads, and record them to a .jsonl
// you can feed back through --replay later.

async function spyMode(username: string) {
  if (!username) throw new Error('usage: --spy <username>');
  const { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } = await import('tiktok-live-connector');
  if (EULER_API_KEY) SignConfig.apiKey = EULER_API_KEY;

  const out = path.join(process.cwd(), `spy-${username}-${Date.now()}.jsonl`);
  const sink = fs.createWriteStream(out, { flags: 'a' });
  // Short path on purpose: this line is printed while streaming often enough that the
  // full path would put the operator's username on screen.
  console.log(`[spy] recording payloads to ${shortPath(out)} (in the current directory)`);
  console.log('[spy] that file contains real viewers\' display names and ids. It is gitignored; keep it local.');

  const jsonl = (o: any) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';

  const tiktok = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true });
  tiktok.on(WebcastEvent.GIFT, (data: any) => {
    console.log('--- raw gift payload ---');
    console.dir(data, { depth: 3 });
    sink.write(jsonl({ __event: 'gift', ...data }));
  });
  tiktok.on(WebcastEvent.FOLLOW, (data: any) => {
    console.log('--- raw follow payload ---');
    console.dir(data, { depth: 3 });
    sink.write(jsonl({ __event: 'follow', ...data }));
  });
  // Likes are the highest-volume event on the wire by a wide margin, so the full dump
  // is printed once - that is all you need to pin the field paths - and every event
  // after it is one line. All of them are still written to the recording.
  let likesSeen = 0;
  tiktok.on(WebcastEvent.LIKE, (data: any) => {
    likesSeen++;
    if (likesSeen === 1) {
      console.log('--- raw like payload (printed once, the rest are one line each) ---');
      console.dir(data, { depth: 3 });
    } else {
      console.log(`[spy] like +${data?.count} total ${data?.total} (${likesSeen} like events so far)`);
    }
    sink.write(jsonl({ __event: 'like', ...data }));
  });
  tiktok.on(ControlEvent.ERROR, (e: any) => console.error('[spy] error:', e?.message ?? e));

  const state = await tiktok.connect();
  console.log(`[spy] watching @${username}, roomId ${state.roomId}. Waiting for gifts.`);
}

// ---------- mode: --replay <file.jsonl> ----------
// Replays recorded gift payloads through handleGift. This is how you test live mode
// without being live. Pair with --dry to test with no Minecraft server either.

async function replayMode(file: string) {
  if (!file) throw new Error('usage: --replay <file.jsonl>');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  console.log(`[replay] ${lines.length} payloads from ${file}`);
  await connectRcon();

  for (const [i, line] of lines.entries()) {
    let data: any;
    try { data = JSON.parse(line); }
    catch { console.warn(`[replay] line ${i + 1} is not JSON, skipping`); continue; }
    if (data.__event === 'follow') guard('replay:follow', () => handleFollow(data, 'replay:follow'));
    else if (data.__event === 'like') guard('replay:like', () => handleLike(data, 'replay:like'));
    else guard('replay', () => handleGift(data, 'replay'));
    await sleep(400);
  }

  // Let everything the replay started actually finish. Stopping at "the queue is
  // empty" is what made --replay unable to replay a gift with delayed stages at all:
  // BURIED's seal lands 2.5s after the pit opens, and the finale is nine seconds long,
  // so both were dropped on the floor with nothing printed.
  const left = await settle('replay');
  if (left.stages > 0) {
    console.warn(`[replay] gave up with ${left.stages} delayed stage(s) still pending,` +
      ` ${left.commands} command(s) that never ran.`);
  }
  if (left.queued > 0) {
    console.warn(`[replay] gave up with ${left.queued} command(s) still queued and undelivered.` +
      ' The server was not reachable for long enough to drain them.');
  }
  console.log(`[replay] done. sent=${stats.sent} expired=${stats.expired} dropped=${stats.dropped}`);
  await shutdown(0);
}

// ---------- mode: live ----------

let ttAttempt = 0;

async function liveMode(username: string) {
  const lib = await import('tiktok-live-connector');
  const { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } = lib;

  // No key still works: Euler signs at free community rate limits, a key just raises them.
  if (EULER_API_KEY) SignConfig.apiKey = EULER_API_KEY;
  else console.warn('[tiktok] no EULER_API_KEY, using free community sign limits');

  await connectRcon();

  const connect = async () => {
    if (shuttingDown) return;
    const tiktok = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true });

    // Handlers run inside the library's event emit. An exception thrown here is an
    // UNCAUGHT exception, not a rejected promise, and it takes the process down mid
    // stream. One malformed payload is not worth the whole show.
    tiktok.on(WebcastEvent.GIFT, (data: any) => guard('gift', () => handleGift(data)));
    tiktok.on(WebcastEvent.FOLLOW, (data: any) => guard('follow', () => handleFollow(data)));
    tiktok.on(WebcastEvent.LIKE, (data: any) => guard('like', () => handleLike(data)));
    tiktok.on(ControlEvent.ERROR, (e: any) => console.error('[tiktok] error:', e?.message ?? e));
    tiktok.on(ControlEvent.DISCONNECTED, () => {
      if (shuttingDown) return;
      const wait = backoff(ttAttempt++, TT_BACKOFF_MIN, TT_BACKOFF_MAX);
      console.warn(`[tiktok] disconnected, reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(() => { void connect(); }, wait);
    });

    try {
      const state = await tiktok.connect();
      ttAttempt = 0;
      console.log(`[tiktok] connected to @${username}, roomId ${state.roomId}`);
    } catch (err: any) {
      // Classify, because these fail very differently and only one is worth retrying fast.
      const n = err?.constructor?.name ?? '';
      if (n === 'PremiumFeatureError') {
        console.error('[tiktok] Euler says this route is paid-tier only:', err?.message);
        console.error('[tiktok] not retrying, this will not fix itself');
        return;
      }
      if (n === 'SignatureRateLimitError') {
        const retry = Math.max((err?.retryAfter ?? 60) * 1000, TT_BACKOFF_MIN);
        console.error(`[tiktok] sign rate limited, retrying in ${Math.round(retry / 1000)}s`);
        setTimeout(() => { void connect(); }, retry);
        return;
      }
      const offline = n === 'UserOfflineError' || /offline|not.*live/i.test(err?.message ?? '');
      const wait = offline ? 30_000 : backoff(ttAttempt++, TT_BACKOFF_MIN, TT_BACKOFF_MAX);
      console.warn(`[tiktok] ${offline ? `@${username} is not live` : `connect failed: ${err?.message}`}, retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => { void connect(); }, wait);
    }
  };

  await connect();
}


// ---------- mode: --catalog [username] ----------
// Pull the gift panel from a live room and write it in the format --keys reads.
//
// WHY THIS EXISTS. gifts-CA.json was scraped from a third-party website, and a scrape
// is a snapshot of somebody else's page. It went stale: four gifts in the map had been
// retired from the real panel while the file still listed them, so --keys reported
// clean on four effects that could not fire. The room's own gift list is the panel,
// for the right region, right now.
//
// WHERE THE DATA COMES FROM, read out of the installed library rather than guessed:
// enableExtendedGiftInfo makes TikTokLiveConnection populate `availableGifts` on
// connect, and both that and fetchAvailableGifts() resolve to whatever
// fetchRoomGiftsRoute returns, which is `(await getJsonObjectFromWebcastApi('gift/list/',
// ...)).data.gifts` - the raw array from TikTok's own endpoint, passed through with no
// key renaming. So the fields are TikTok's, in TikTok's spelling.
//
// The library types that value as `any`, and this repo has been bitten twice by field
// paths moving between versions, so normalizeCatalogGifts() accepts the spellings that
// have been seen and REFUSES to write a file it could not read, printing the real keys
// instead. A catalog written from a shape nobody understood would be worse than no
// catalog at all: it is the file every other check trusts.

export type CatalogGiftEntry = { name: string; coins: number };

export function normalizeCatalogGifts(raw: unknown): CatalogGiftEntry[] {
  const list: unknown =
    Array.isArray(raw) ? raw
    : Array.isArray((raw as any)?.gifts) ? (raw as any).gifts
    : Array.isArray((raw as any)?.data?.gifts) ? (raw as any).data.gifts
    : undefined;

  if (!Array.isArray(list) || list.length === 0) {
    const shape = raw && typeof raw === 'object' ? `object with keys: ${Object.keys(raw as object).join(', ')}` : typeof raw;
    throw new Error(
      `could not find a gift array in what the library returned (${shape}).\n` +
      '       The connector\'s gift list has moved. Run --spy and inspect the shape before trusting anything here.',
    );
  }

  const gifts: CatalogGiftEntry[] = [];
  for (const g of list as any[]) {
    const name = g?.name ?? g?.giftName ?? g?.gift_name;
    const rawCoins = g?.diamond_count ?? g?.diamondCount ?? g?.coin_price ?? g?.coins;
    const coins = Math.trunc(Number(rawCoins));
    if (typeof name === 'string' && name.trim() && Number.isFinite(coins) && coins >= 0) {
      gifts.push({ name: name.trim(), coins });
    }
  }

  if (!gifts.length) {
    const keys = Object.keys((list as any[])[0] ?? {}).join(', ') || '(none)';
    throw new Error(
      `found ${list.length} gift entries but none had a readable name and price.\n` +
      `       Keys on the first entry: ${keys}\n` +
      '       Add whichever of those is the name and the coin price to normalizeCatalogGifts().',
    );
  }

  // Sorted, so that a refreshed file diffs cleanly against the last one instead of
  // reshuffling with the panel order.
  return gifts.sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name));
}

/** What changed against the catalog already on disk. This is the part that catches drift. */
function diffCatalog(before: CatalogGiftEntry[], after: CatalogGiftEntry[]) {
  const priceOf = (list: CatalogGiftEntry[]) => new Map(list.map((g) => [key(g.name), g] as const));
  const was = priceOf(before);
  const now = priceOf(after);
  const added = after.filter((g) => !was.has(key(g.name)));
  const removed = before.filter((g) => !now.has(key(g.name)));
  const repriced = after.filter((g) => {
    const old = was.get(key(g.name));
    return old && old.coins !== g.coins;
  });
  return { added, removed, repriced };
}

async function catalogMode(username: string, outPath: string, regionOverride: string) {
  const { TikTokLiveConnection, SignConfig } = await import('tiktok-live-connector');
  if (EULER_API_KEY) SignConfig.apiKey = EULER_API_KEY;
  else console.warn('[catalog] no EULER_API_KEY, using free community sign limits');

  // Whatever is already at the output path, for the diff and for the region default.
  let previous: any = null;
  try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* first run */ }
  const region = (regionOverride || previous?.region || 'XX').toUpperCase();

  console.log(`[catalog] connecting to @${username} to read the gift panel`);
  const tiktok = new TikTokLiveConnection(username, { enableExtendedGiftInfo: true });

  let gifts: CatalogGiftEntry[];
  try {
    const state = await tiktok.connect();
    console.log(`[catalog] connected, roomId ${state.roomId}`);
    const raw = (tiktok as any).availableGifts ?? await (tiktok as any).fetchAvailableGifts();
    gifts = normalizeCatalogGifts(raw);
  } catch (err: any) {
    console.error(`[catalog] ${err?.message ?? err}`);
    // "Failed to retrieve Room ID" is what a handle that is not live looks like from
    // here, and it is the overwhelmingly common reason this fails.
    if (/offline|not.*live|room id/i.test(err?.message ?? '') || err?.constructor?.name === 'UserOfflineError') {
      console.error('[catalog] a room only has a gift panel while it is LIVE, and only a live room can');
      console.error('[catalog] be connected to. Start your stream and run this again, or point --catalog');
      console.error('[catalog] at someone who is live in your region. Check the handle spelling too.');
    }
    await tiktok.disconnect().catch(() => {});
    return shutdown(1);
  }
  await tiktok.disconnect().catch(() => {});

  const coins = gifts.map((g) => g.coins);
  console.log(`[catalog] ${gifts.length} gifts, ${Math.min(...coins)} to ${Math.max(...coins)} coins`);

  if (previous?.gifts?.length) {
    const { added, removed, repriced } = diffCatalog(previous.gifts, gifts);
    const show = (label: string, list: CatalogGiftEntry[]) => {
      if (!list.length) return;
      console.log(`[catalog] ${label}: ${list.length}`);
      for (const g of list.slice(0, 12)) console.log(`            ${g.name} (${g.coins}c)`);
      if (list.length > 12) console.log(`            ... and ${list.length - 12} more`);
    };
    console.log(`[catalog] against the file already on disk (captured ${previous.capturedAt ?? 'unknown'}):`);
    show('gifts that are new', added);
    show('gifts that are GONE from the panel', removed);
    show('gifts whose price changed', repriced);
    if (!added.length && !removed.length && !repriced.length) console.log('            no changes');
  }

  const doc = {
    _readme: 'A dated SNAPSHOT of one region\'s TikTok gift panel, not a live source of truth. It is the input to `npx tsx bridge.ts --keys`, which checks that every key in gift-map.ts is a gift that actually exists at the price the map assumes.',
    region,
    source: 'the live gift panel of the connected room, via tiktok-live-connector (enableExtendedGiftInfo)',
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedBy: 'npx tsx bridge.ts --catalog',
    catalogUpdated: new Date().toISOString().slice(0, 10),
    drifts: 'Gift names and prices are region-specific and TikTok retires and renames them without notice. This file is dated and WILL go stale: four mapped gifts were silently unreachable for months because the file it replaced was three months old. Re-run --catalog before any stream where balance matters.',
    giftCount: gifts.length,
    gifts,
  };

  fs.writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
  console.log(`[catalog] wrote ${shortPath(outPath)} (region ${region}, captured ${doc.capturedAt})`);
  console.log(`[catalog] now run: npx tsx bridge.ts --keys ${shortPath(outPath)}`);
  return shutdown(0);
}

// ---------- mode: --verify ----------
// Syntax-checks every command in the map against THIS server without executing any
// of them. Each command is wrapped in an `execute if entity` whose selector matches
// nothing, so the server parses the inner command in full and then declines to run it.
// Parse errors still come back, execution never happens.
//
// What this catches: unknown commands, wrong argument order or count, blocks / items /
// effects / entities that do not exist in this version, tellraw the parser won't accept,
// and subcommands like `execute if items` that may not exist here.
//
// Delayed stages are included. Anything a gift schedules through later() is collected
// rather than scheduled while verify runs (see later() above), so a single --verify pass
// covers the finale's lightning rings, particles, withers and title card, and the buried
// gift's stone seal. The count of delayed commands picked up is printed, so a run where
// collection silently broke is visible at a glance instead of looking like a clean pass.
//
// What this CANNOT catch: unknown keys inside a summon NBT blob. Entity NBT parses as
// generic SNBT whatever the keys are called, so a renamed key still "passes" here and
// the entity silently uses its default. This bit us once: `{Fuse:60}` on TNT verified
// clean while doing nothing, because `Fuse` was renamed to `fuse` in 1.20.3 (23w42a)
// and 26.2 had been quietly using the 80-tick default all along. The map now uses
// lowercase `fuse`. If a future gift adds entity NBT, confirm it by observed BEHAVIOUR
// (time the effect, watch the entity) and not by a green line here.

const NEVER = 'execute if entity @e[tag=__bridge_verify_never__,limit=1] run ';

async function verifyMode() {
  if (DRY) throw new Error('--verify needs a real server, drop --dry');
  await connectRcon();

  for (let i = 0; i < 20 && linkState !== 'up'; i++) await sleep(500);
  if (linkState !== 'up' || !rcon) throw new Error('could not reach RCON, is the server up?');

  const samples: Array<[string, string]> = [];
  const seen = new Set<string>();
  let delayedCollected = 0;   // raw commands registered through later(), duplicates included
  let delayedChecked = 0;     // of those, the distinct ones that entered the check list

  const add = (label: string, cmds: string[]) => {
    for (const c of cmds) if (!seen.has(c)) { seen.add(c); samples.push([label, c]); }
  };

  // Run the action, take its immediate commands, then take everything it scheduled.
  // Delayed entries are labelled with their offset so a FAIL points at the stage.
  const addGift = (label: string, cmds: string[]) => {
    add(label, cmds);
    for (const { ms, cmd } of takeDeferred()) {
      delayedCollected++;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      delayedChecked++;
      samples.push([`${label}+${(ms / 1000).toFixed(1)}s`, cmd]);
    }
  };

  for (const [name, action] of Object.entries(GIFTS)) addGift(name, action(1));
  // PRICED variants that carry their own body are not reachable through GIFTS, so they
  // would otherwise never be syntax-checked. Variants without an `action` reuse the
  // GIFTS body already covered above.
  for (const [name, variants] of Object.entries(PRICED))
    for (const v of variants)
      if (v.action) addGift(`${name}@>=${v.minCoins}`, v.action(1));
  for (const coins of [1, 5, 25, 99, 299, 700, 1000, 7000]) addGift(`fallback:${coins}c`, fallback(coins));
  add('follow', [banner('NEW FOLLOWER tester', 'green'), `give ${MC_PLAYER} golden_carrot 1`]);
  add('likes', likeCreeperCommands(LIKES_PER_CREEPER));

  const delayedDupes = delayedCollected - delayedChecked;
  console.log(`\n[verify] checking ${samples.length} distinct commands against the live server`);
  console.log(`[verify] ${delayedChecked} of them are delayed later() payloads` +
    ` (${delayedCollected} collected, ${delayedDupes} already listed as immediate commands)`);
  if (delayedCollected === 0) {
    console.warn('[verify] WARNING: no later() payloads were collected. Delayed stages are' +
      ' NOT being checked - the collector is broken, this is not a clean run.');
  }
  console.log('[verify] nothing will actually run\n');

  const bad: Array<[string, string, string]> = [];
  for (const [label, cmd] of samples) {
    let reply = '';
    try { reply = await rcon.send(NEVER + cmd); }
    catch (err) { reply = `send failed: ${(err as Error).message}`; }
    const r = (reply ?? '').trim();
    const failed = /^(Unknown|Incorrect|Expected|Invalid|Could not|Failed|send failed)/i.test(r) || r.includes('<--[HERE]');
    if (failed) { bad.push([label, cmd, r]); console.log(`  FAIL  ${label.padEnd(20)} ${cmd}`); }
    else console.log(`  ok    ${label.padEnd(20)} ${cmd.slice(0, 90)}`);
  }

  console.log(`\n[verify] ${samples.length - bad.length}/${samples.length} passed` +
    ` (${delayedChecked} of the ${samples.length} were delayed later() payloads)`);
  for (const [label, cmd, why] of bad) {
    console.log(`\n  ${label}\n    ${cmd}\n    ${why.slice(0, 300)}`);
  }
  await shutdown(bad.length ? 1 : 0);
}

// ---------- mode: --keys ----------
// Checks the MAP against the region's gift catalog. `--verify` checks that the commands
// are valid Minecraft; this checks that the keys are reachable at all. They catch
// disjoint failures and neither substitutes for the other.
//
// Every dead key found so far - coffee, dancingflower, rocket, handhearts - was found by
// hand, one at a time, after the effect had been silently unreachable for weeks. Nothing
// in the runtime complains about a key no gift produces: the gift just falls through to
// fallback() and does something plausible.
//
// Reads a saved dump so it works offline and gives the same answer twice. Regenerate the
// dump with catalog-scrape.js, pasted into a browser console. Do NOT regenerate it with an
// HTTP fetch or a page-summarising tool: they truncate the gift page around 499 coins and
// report every gift above that as absent, which looks exactly like a real absence.

// Default catalog, resolved next to these source files rather than relative to the
// directory the command was run from, so `--keys` works from anywhere. An explicit
// `--keys some/other.json` is still relative to where you are standing, as expected.
// Regenerate one for your own region with catalog-scrape.js.
const CATALOG_DEFAULT = path.join(__dirname, 'gifts-CA.json');

// A catalog is a photograph of a moving thing. This one went three months without being
// re-taken and four gifts in the map were retired underneath it, while --keys kept
// reporting clean, because --keys was checking the map against the photograph rather
// than against the panel. Age is now part of the answer.
const CATALOG_STALE_DAYS = 35;

/** Whole days between a catalog date and now, or null if there is no usable date. */
export function catalogAgeDays(capturedAt: unknown, now = Date.now()): number | null {
  if (typeof capturedAt !== 'string') return null;
  const at = Date.parse(capturedAt);
  if (!Number.isFinite(at)) return null;
  return Math.floor((now - at) / 86_400_000);
}

/**
 * How old the catalog's DATA is, which is not the same as how recently the file was
 * written. The shipped file is the case in point: its `capturedAt` says the day someone
 * last rewrote the header, while `catalogUpdated` says June 23, and the gift list is
 * from June 23. A file rewritten today out of June data is June data.
 *
 * So take the OLDEST date the file admits to and report that one.
 */
export function catalogAge(doc: any, now = Date.now()): { days: number; date: string } | null {
  const dated = ['catalogUpdated', 'capturedAt']
    .map((field) => ({ days: catalogAgeDays(doc?.[field], now), date: String(doc?.[field]) }))
    .filter((d): d is { days: number; date: string } => d.days !== null);
  if (!dated.length) return null;
  return dated.reduce((oldest, d) => (d.days > oldest.days ? d : oldest));
}

type CatalogGift = { name: string; coins: number };

async function keysMode(catalogPath: string) {
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    console.error(`[keys] cannot read catalog ${catalogPath}: ${(err as Error).message}`);
    console.error('[keys] regenerate it with catalog-scrape.js - see that file for how.');
    return shutdown(1);
  }

  const gifts: CatalogGift[] = doc?.gifts ?? [];
  if (!gifts.length) return console.error('[keys] catalog has no gifts in it'), shutdown(1);

  console.log(`\n[keys] catalog ${shortPath(catalogPath)}: region ${doc.region}, ${gifts.length} gifts, dated ${doc.catalogUpdated}`);

  const age = catalogAge(doc);
  const stale = age !== null && age.days > CATALOG_STALE_DAYS;
  if (age === null) {
    console.warn(`[keys] WARNING: this catalog carries no usable date, so its age cannot be`);
    console.warn(`[keys] checked. Refresh it with --catalog to get one.`);
  } else if (stale) {
    console.warn(`[keys] WARNING: this catalog describes the panel as of ${age.date}, which is`);
    console.warn(`[keys] ${age.days} days ago. TikTok retires and renames gifts without notice, so`);
    console.warn('[keys] everything below is checked against a photograph of the panel rather than');
    console.warn('[keys] the panel. A clean run on a stale file means very little.');
    console.warn('[keys] Refresh it while your stream is live: npx tsx bridge.ts --catalog');
  }
  console.log(`[keys] checking ${Object.keys(GIFTS).length} map keys\n`);

  // Normalized catalog: key -> the distinct coin values gifts with that key are sold at.
  // Two catalog rows with the SAME name and SAME price are just a duplicate listing and
  // are harmless. A collision only matters when the prices differ, because that is when
  // the map cannot tell which gift arrived.
  const byKey = new Map<string, { names: Set<string>; coins: Map<number, string> }>();
  for (const g of gifts) {
    const k = key(g.name);
    if (!byKey.has(k)) byKey.set(k, { names: new Set(), coins: new Map() });
    const e = byKey.get(k)!;
    e.names.add(g.name);
    e.coins.set(g.coins, g.name);
  }

  const fail: string[] = [];
  const warn: string[] = [];

  // --- 1. dead keys: nothing in the catalog produces this key ---
  const dead: string[] = [];
  for (const k of Object.keys(GIFTS)) if (!byKey.has(k)) dead.push(k);
  if (dead.length) {
    console.log('DEAD KEYS - no gift in this region produces these, the effect can never fire:');
    for (const k of dead) {
      const near = [...byKey.keys()].filter((c) => c.startsWith(k) || k.startsWith(c) || c.includes(k)).slice(0, 3);
      console.log(`  FAIL  ${k.padEnd(20)} no catalog gift normalizes to this` +
        (near.length ? `  (did you mean: ${near.join(', ')}?)` : ''));
      fail.push(`dead key: ${k}`);
    }
    if (stale) {
      console.log('  NOTE  the catalog above is stale. A dead key on a stale catalog often means the');
      console.log('        catalog is behind the panel, not that the map is wrong. Run --catalog first.');
    }
    console.log('');
  }

  // --- 2. collisions: two catalog gifts at different prices share one key ---
  const collided = [...byKey.entries()].filter(([, e]) => e.coins.size > 1);
  const mappedCollisions = collided.filter(([k]) => k in GIFTS);
  if (mappedCollisions.length) {
    console.log('COLLISIONS on mapped keys - several gifts at different prices share one key:');
    for (const [k, e] of mappedCollisions) {
      const rows = [...e.coins.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `"${n}" ${c}c`);
      const variants = PRICED[k];
      if (!variants) {
        console.log(`  FAIL  ${k.padEnd(20)} ${rows.join('  |  ')}`);
        console.log(`        ungated: the cheapest one fires the full effect. Add a PRICED entry.`);
        fail.push(`ungated collision: ${k}`);
      } else {
        console.log(`  ok    ${k.padEnd(20)} ${rows.join('  |  ')}   [PRICED]`);
        for (const [c, n] of [...e.coins.entries()].sort((a, b) => a[0] - b[0])) {
          const hit = pickVariant(variants, c);
          console.log(`          "${n}" at ${c}c -> ${hit ? `mapped body (>=${hit.minCoins})` : `fallback(${c})`}`);
        }
      }
    }
    console.log('');
  }
  const unmappedCollisions = collided.length - mappedCollisions.length;
  if (unmappedCollisions) {
    console.log(`[keys] ${unmappedCollisions} more collisions exist among gifts this map does not use - ignored.\n`);
  }

  // --- 3. price drift: ASSUMED_COINS vs the catalog ---
  console.log('PRICES - what the map assumes vs what the catalog says:');
  for (const k of Object.keys(GIFTS)) {
    const assumed = ASSUMED_COINS[k];
    const entry = byKey.get(k);
    if (assumed === undefined) {
      console.log(`  FAIL  ${k.padEnd(20)} no ASSUMED_COINS entry - add one`);
      fail.push(`no assumed price: ${k}`);
      continue;
    }
    if (!entry) continue;   // already reported as a dead key
    const real = [...entry.coins.keys()].sort((a, b) => a - b);
    if (real.includes(assumed)) {
      const extra = real.length > 1 ? `  (also sold at ${real.filter((c) => c !== assumed).join(', ')})` : '';
      console.log(`  ok    ${k.padEnd(20)} ${String(assumed).padStart(6)}c${extra}`);
    } else {
      console.log(`  FAIL  ${k.padEnd(20)} map assumes ${assumed}c, catalog says ${real.join(' / ')}c`);
      fail.push(`price drift: ${k} assumed ${assumed}, real ${real.join('/')}`);
    }
  }

  // --- 4. PRICED entries pointing at keys that are gone or no longer collide ---
  for (const k of Object.keys(PRICED)) {
    if (!(k in GIFTS) && !PRICED[k].every((v) => v.action)) {
      warn.push(`PRICED["${k}"] has no GIFTS body and no action of its own`);
    }
    const e = byKey.get(k);
    if (e && e.coins.size === 1) warn.push(`PRICED["${k}"] no longer collides in this catalog - only one price (${[...e.coins.keys()][0]}c). Harmless, but it can go.`);
  }

  console.log('');
  for (const w of warn) console.log(`  warn  ${w}`);
  if (warn.length) console.log('');

  if (fail.length) {
    console.log(`[keys] ${fail.length} problem(s):`);
    for (const f of fail) console.log(`  - ${f}`);
    console.log('');
    return shutdown(1);
  }
  console.log(`[keys] clean. All ${Object.keys(GIFTS).length} keys are reachable in ${doc.region}, prices match, collisions gated.`);
  if (stale) {
    console.log(`[keys] ...against a catalog ${age!.days} days old. "Clean" means the map agrees with`);
    console.log('[keys] that file, not with the live panel. Refresh with --catalog before you trust it.');
  }
  console.log('');
  return shutdown(0);
}

// ---------- entry ----------

async function shutdown(code = 0) {
  if (shuttingDown) return;

  // Ctrl+C two seconds after a BURIED gift, or four seconds into the finale, means
  // stages that were promised will never run. Interactive quits should not hang for
  // nine seconds waiting, so this warns instead of waiting: the run is abandoned on
  // purpose, and now it is abandoned out loud. --replay, which nobody is watching,
  // waits properly through settle() instead.
  const pending = pendingStageSummary();
  shuttingDown = true;
  if (pending.stages > 0) {
    console.warn(`\n[bridge] WARNING: quitting with ${pending.stages} delayed stage(s) outstanding.` +
      ` ${pending.commands} command(s) will never run; the last was` +
      ` ${(pending.longestMs / 1000).toFixed(1)}s away.`);
    console.warn('[bridge] Gifts like BURIED and THE FINALE finish seconds after they start, so a' +
      ' sequence cut off here leaves the world part-way through it.');
  }
  cancelPendingStages();

  console.log(`\n[bridge] shutting down. sent=${stats.sent} rejected=${stats.rejected}` +
    ` expired=${stats.expired} dropped=${stats.dropped} reconnects=${stats.reconnects}`);
  await rcon?.end().catch(() => {});
  process.exit(code);
}
const args = process.argv.slice(2);
const argAfter = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------- argument checking ----------
// No flag at all means live mode, which used to make every UNRECOGNISED flag mean live
// mode too: `bridge.ts --help` opened a TikTok connection, and a typo like `--verfiy`
// silently ran the wrong mode with no clue that it had. Both stop here now.
const KNOWN_FLAGS = new Set([
  '--test', '--spy', '--replay', '--verify', '--keys', '--catalog',
  '--dry', '--user', '--out', '--region', '--help', '-h',
]);

function usage() {
  console.log(`TikTok LIVE -> Minecraft bridge

  npx tsx bridge.ts                  Live mode. Needs TIKTOK_USER and a running server.
  npx tsx bridge.ts --test           Type gift names by hand. No TikTok.
  npx tsx bridge.ts --spy <user>     Watch a live stream and record payloads to a .jsonl.
  npx tsx bridge.ts --replay <file>  Feed recorded payloads through the live handler.
  npx tsx bridge.ts --verify         Syntax-check every mapped command. Needs the server.
  npx tsx bridge.ts --keys [file]    Check the map against a gift catalog. Needs nothing.
  npx tsx bridge.ts --catalog [user] Read the gift panel from a live room and write it to
                                     the catalog file. Defaults to TIKTOK_USER.

Flags:
  --dry            Log commands instead of sending them.
  --user <name>    Override TIKTOK_USER for live mode.
  --out <path>     Where --catalog writes. Defaults to the file --keys reads.
  --region <code>  Region code to stamp on a catalog. Defaults to the existing file's.
  --help, -h       This text.

Configuration comes from .env in this folder, or from the environment. Copy .env.example
to .env and fill it in. Shell variables override the file. See docs/SETUP.md.

Before a stream: --catalog while you are live, then --keys, then --verify, then --test.
README.md explains why each one catches something the others cannot.`);
}

const liveUser = argAfter('--user') ?? TIKTOK_USER;

const MODE =
  args.includes('--keys')      ? 'keys'
  : args.includes('--catalog') ? 'catalog'
  : args.includes('--verify') ? 'verify'
  : args.includes('--test')   ? 'test'
  : args.includes('--spy')    ? 'spy'
  : args.includes('--replay') ? 'replay'
  : 'live';

// ---------- preflight ----------
// Everything personal is read from the environment, so an unset variable is the most
// likely first-run failure. Fail here, naming the variable, rather than letting a
// command like `execute at  run summon tnt` reach the server and half-work.
function configError(msg: string): never {
  console.error(`fatal: ${msg}`);
  console.error(envSourceHint());
  console.error('.env.example lists every variable this bridge reads; docs/SETUP.md walks through setting them.');
  process.exit(1);
}

// `--keys` takes an OPTIONAL catalog path. Without this guard, `--keys --dry` would try to
// read a catalog called "--dry" and fail in a confusing way.
const argPath = (flag: string) => {
  const v = argAfter(flag);
  return v && !v.startsWith('--') ? v : undefined;
};

// --catalog takes an OPTIONAL username, the same way --keys takes an optional path.
const catalogUser = argPath('--catalog') ?? TIKTOK_USER;

// ---------- run ----------
// Everything with a side effect lives behind this guard. bridge.test.ts IMPORTS this
// file to test resolve() and sanitize() offline, and importing it must not parse argv,
// must not exit over a missing MC_PLAYER, and must not start a mode.
if (require.main === module) {
  for (const a of args) {
    if (a.startsWith('-') && !KNOWN_FLAGS.has(a)) {
      console.error(`fatal: unknown option ${a}\n`);
      usage();
      process.exit(1);
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  // --keys reads a saved catalog, --spy only records payloads, and --catalog only reads
  // the gift panel. None of them sends a command, so none needs to know who the player is.
  if (MODE !== 'keys' && MODE !== 'spy' && MODE !== 'catalog' && !MC_PLAYER) {
    configError('MC_PLAYER is not set. It is your exact in-game name, case sensitive, and every command targets it.');
  }
  if (MODE === 'live' && !liveUser) {
    configError('no TikTok handle to watch: set TIKTOK_USER, or pass --user <name>.');
  }
  if (MODE === 'catalog' && !catalogUser) {
    configError('no TikTok handle for --catalog: pass one (--catalog someuser), or set TIKTOK_USER.');
  }

  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });

  const run =
    MODE === 'keys'      ? keysMode(argPath('--keys') ?? CATALOG_DEFAULT)
    : MODE === 'catalog' ? catalogMode(catalogUser, argPath('--out') ?? CATALOG_DEFAULT, argPath('--region') ?? '')
    : MODE === 'verify' ? verifyMode()
    : MODE === 'test'   ? testMode()
    : MODE === 'spy'    ? spyMode(argAfter('--spy')!)
    : MODE === 'replay' ? replayMode(argAfter('--replay')!)
    : liveMode(liveUser);

  run.catch((e) => {
    console.error('fatal:', e?.message ?? e);
    process.exit(1);
  });
}
