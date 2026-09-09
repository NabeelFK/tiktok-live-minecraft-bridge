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
let stats = { sent: 0, expired: 0, dropped: 0, reconnects: 0, rejected: 0, followsDropped: 0 };

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
// Two separate guards, because follow bursts have two different causes:
//   - the same account re-following to farm the reward -> dedupe on user id
//   - a raid or a bot wave of distinct accounts        -> token bucket per minute
// Without the bucket a 200-account raid is 200 golden carrots in one inventory.

const FOLLOW_CARROTS_PER_MIN = 6;
const followWindow: number[] = [];
const seenFollowers = new Set<string>();

function handleFollow(data: any, tag = 'follow') {
  const name = sanitize(data?.user?.nickname ?? 'someone');
  const id = String(data?.user?.id ?? name);

  if (seenFollowers.has(id)) {
    console.log(`[${tag}] ${name} already counted this session`);
    return;
  }
  seenFollowers.add(id);

  const now = Date.now();
  while (followWindow.length && now - followWindow[0] > 60_000) followWindow.shift();
  if (followWindow.length >= FOLLOW_CARROTS_PER_MIN) {
    stats.followsDropped++;
    console.log(`[${tag}] ${name} rate limited, no carrot`);
    return;
  }
  followWindow.push(now);

  console.log(`[${tag}] ${name} -> golden carrot`);
  enqueue([banner(`NEW FOLLOWER ${name}`, 'green'), `give ${MC_PLAYER} golden_carrot 1`]);
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

async function testMode() {
  await connectRcon();
  console.log('\nType: <gift name> [count] [!coins]   e.g.  rose 5     or    unknown thing !1500');
  console.log('Or:   follow <name>                  to test the follow reward and its rate limit');
  console.log('Known gifts:', Object.keys(GIFTS).join(', '));
  console.log('Anything else falls through to the coin-value fallback.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    let parts = line.trim().split(/\s+/);
    if (!parts[0]) return;

    // `follow <name>` exercises the follow path, rate limiter included.
    if (parts[0].toLowerCase() === 'follow') {
      const who = parts.slice(1).join(' ') || 'tester';
      handleFollow({ user: { nickname: who, id: `test:${who.toLowerCase()}` } }, 'test');
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
  for (const coins of [1, 5, 25, 99, 299, 700, 1000]) addGift(`fallback:${coins}c`, fallback(coins));
  add('follow', [banner('NEW FOLLOWER tester', 'green'), `give ${MC_PLAYER} golden_carrot 1`]);

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
  console.log(`[keys] clean. All ${Object.keys(GIFTS).length} keys are reachable in ${doc.region}, prices match, collisions gated.\n`);
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

  console.log(`\n[bridge] shutting down. sent=${stats.sent} rejected=${stats.rejected} expired=${stats.expired} dropped=${stats.dropped} reconnects=${stats.reconnects} followsRateLimited=${stats.followsDropped}`);
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
  '--test', '--spy', '--replay', '--verify', '--keys', '--dry', '--user', '--help', '-h',
]);

function usage() {
  console.log(`TikTok LIVE -> Minecraft bridge

  npx tsx bridge.ts                  Live mode. Needs TIKTOK_USER and a running server.
  npx tsx bridge.ts --test           Type gift names by hand. No TikTok.
  npx tsx bridge.ts --spy <user>     Watch a live stream and record payloads to a .jsonl.
  npx tsx bridge.ts --replay <file>  Feed recorded payloads through the live handler.
  npx tsx bridge.ts --verify         Syntax-check every mapped command. Needs the server.
  npx tsx bridge.ts --keys [file]    Check the map against a gift catalog. Needs nothing.

Flags, any mode:
  --dry            Log commands instead of sending them.
  --user <name>    Override TIKTOK_USER for live mode.
  --help, -h       This text.

Configuration comes from .env in this folder, or from the environment. Copy .env.example
to .env and fill it in. Shell variables override the file. See docs/SETUP.md.

Before a stream: --keys, then --verify, then --test. README.md explains why all three.`);
}

const liveUser = argAfter('--user') ?? TIKTOK_USER;

const MODE =
  args.includes('--keys')     ? 'keys'
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

  // --keys reads a saved catalog and --spy only records payloads. Neither sends a
  // command, so neither needs to know who the player is.
  if (MODE !== 'keys' && MODE !== 'spy' && !MC_PLAYER) {
    configError('MC_PLAYER is not set. It is your exact in-game name, case sensitive, and every command targets it.');
  }
  if (MODE === 'live' && !liveUser) {
    configError('no TikTok handle to watch: set TIKTOK_USER, or pass --user <name>.');
  }

  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });

  const run =
    MODE === 'keys'     ? keysMode(argPath('--keys') ?? CATALOG_DEFAULT)
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
