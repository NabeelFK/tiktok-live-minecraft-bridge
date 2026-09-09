/**
 * gift-helpers.ts - the small builders the gift map is written in.
 *
 * These exist so gift-map.ts can stay one line per effect instead of one line per
 * command. The engine (bridge.ts) imports from here too, but nothing in this file
 * knows anything about TikTok, RCON or the command queue.
 *
 * Available to the map: at, banner, clearItems, ifHolding, ring, randomOffset,
 * rep, later, clamp, key, and the ALL_TOOLS / EQUIP_SLOTS lists.
 */

// The exact in-game name every command targets, case sensitive. Read from the
// environment so no personal detail lives in the source. bridge.ts refuses to start
// any mode that sends commands when this is empty.
export const MC_PLAYER = (process.env.MC_PLAYER ?? '').trim();

// `at` reruns the command at the player's position. RCON runs from the server
// console, which sits at world origin, so without this everything spawns at spawn.
//
// IMPORTANT: `execute at <player>` moves the POSITION context but not the executor.
// The executor is still the console, which is not an entity, so `@s` does not exist
// inside an at() command. Always name the player explicitly.
export const at = (cmd: string) => `execute at ${MC_PLAYER} run ${cmd}`;

export type Action = (repeat: number) => string[];

/** One entry in a PRICED list: the cheapest unit price that buys this body. */
export type PricedVariant = { minCoins: number; action?: Action };

// Match on a normalized key so "Finger Heart", "finger heart" and "FingerHeart" all land.
export const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- delayed commands ----------
// Schedule follow-up commands. Used for cleanup passes and staged sequences that
// must not run immediately.
//
// The map calls later() and does not care what happens next. The engine decides
// that by installing a scheduler at startup:
//   - a normal run schedules a real timer that enqueues the commands when it fires
//   - --verify collects them instead, so a gift's delayed stages are syntax-checked
//     in the same pass as its immediate ones
//
// Delayed commands are the ones that do not exist at the moment verify runs, which
// once made the highest-risk part of the map (the whole finale, and the buried
// gift's stone seal) the only part that was never checked.
//
// There is deliberately no default scheduler. A silent no-op here would drop every
// delayed stage on the floor and still report a clean verify run.
export type Deferred = { ms: number; cmd: string };
type Scheduler = (ms: number, cmds: string[]) => void;

let scheduler: Scheduler | null = null;

export function installScheduler(fn: Scheduler) {
  scheduler = fn;
}

export function later(ms: number, cmds: string[]) {
  if (!scheduler) {
    throw new Error('later() was called before installScheduler(); the engine must install one at startup');
  }
  scheduler(ms, cmds);
}

// Small builders. Keep the map readable: one line per effect, not per command.
export const banner = (text: string, color: string) =>
  `tellraw @a {"text":"${text}","color":"${color}","bold":true}`;

export const clearItems = (items: string[]) => items.map((i) => `clear ${MC_PLAYER} minecraft:${i}`);

// Gate a message on actually holding the thing, so a wipe never announces a
// theft that did not happen. `container.*` is the whole player inventory.
export const ifHolding = (predicate: string, cmd: string) =>
  `execute if items entity ${MC_PLAYER} container.* ${predicate} run ${cmd}`;

// Evenly spaced points on a circle around the player. Used for mob waves and
// the finale's lightning ring.
export const ring = (radius: number, count: number, make: (dx: number, dz: number) => string) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return make(Math.round(Math.cos(a) * radius), Math.round(Math.sin(a) * radius));
  });

// A random horizontal offset at a given distance range, as `~dx ~dz`.
export const randomOffset = (min: number, max: number) => {
  const a = Math.random() * Math.PI * 2;
  const d = min + Math.random() * (max - min);
  return `~${Math.round(Math.cos(a) * d)} ~${Math.round(Math.sin(a) * d)}`;
};

// Gear lists, built here so the command list stays explicit (and therefore
// version-proof) without 40 lines of literals in the map.
export const TOOL_MATS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
export const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];
export const ALL_TOOLS = TOOL_MATS.flatMap((m) => TOOL_KINDS.map((k) => `${m}_${k}`));
export const EQUIP_SLOTS = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet', 'weapon.mainhand', 'weapon.offhand'];

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Repeat a command N times, capped.
//
// Repeating only multiplies the effect when the command CREATES something new.
// `setblock`, `fill`, `effect give`, `give` and `item replace` all address the same
// block / player / slot every time, so N copies collapse into exactly one effect.
// Scale those on their own arguments instead (see `gg`'s radius and `heartme`'s count).
// This guard exists so the next person to add a gift finds out immediately.
const REPEATABLE = /\b(summon|particle|playsound)\b/;
const repWarned = new Set<string>();

export function rep(streak: number, perGift: number, cmd: string, cap = 40): string[] {
  if (!REPEATABLE.test(cmd) && !repWarned.has(cmd)) {
    repWarned.add(cmd);
    console.warn(`[map] rep() on a non-repeatable command, copies collapse to one effect: ${cmd}`);
  }
  return Array(clamp(Math.round(streak * perGift), 1, cap)).fill(cmd);
}

