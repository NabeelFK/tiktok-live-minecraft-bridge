/**
 * gift-map.ts - which TikTok gift does what in Minecraft.
 *
 * THIS IS THE FILE TO EDIT. Everything a person customising this bridge needs to
 * change lives here; bridge.ts is the engine and does not need opening.
 *
 * Three exports, and `--keys` checks all three against the region's gift catalog:
 *   ASSUMED_COINS  what each key is assumed to cost
 *   GIFTS          key -> the commands that gift runs
 *   PRICED         keys where two different gifts normalize to the same name
 * plus fallback(), which decides what an unmapped gift does.
 *
 * Keys are normalized gift names: lowercased with everything that is not a letter
 * or a digit stripped out, so "Finger Heart" is `fingerheart`. A key no gift in
 * your region produces can never fire, and nothing at runtime will tell you - that
 * is what `npx tsx bridge.ts --keys` is for. Run it after every edit here.
 *
 * The prices in the comments below are the Canadian catalog as of June 2026. They
 * are region-specific and they drift; see docs/GOTCHAS.md.
 */

import {
  ALL_TOOLS,
  EQUIP_SLOTS,
  MC_PLAYER,
  at,
  banner,
  clamp,
  clearItems,
  later,
  randomOffset,
  rep,
  ring,
  type Action,
  type PricedVariant,
} from './gift-helpers';

// What each key is assumed to COST, checked against the real catalog by `--keys`.
//
// This table, not the prose in the map comments, is what --keys reads. Regexing coin
// values out of English sentences is not a check you can trust - the comments explain
// WHY a price matters, this declares WHAT it is. Keep the two in step; --keys will tell
// you when this table and the catalog disagree, but nothing can tell you when this table
// and a comment disagree.
//
// Every key in GIFTS must appear here. --keys fails on a missing entry.
export const ASSUMED_COINS: Record<string, number> = {
  rose: 1, tiktok: 1, gg: 1, icecreamcone: 1, heartme: 1,
  fingerheart: 5, friendshipnecklace: 10, perfume: 20, doughnut: 30,
  papercrane: 99, hatandmustache: 99, loveyou: 199, handheart: 100, flowers: 100,
  balloons: 200, corgi: 299, celloromance: 299, moneygun: 500, swan: 699,
  train: 899, galaxy: 1000, sportscar: 7000,
};

export const GIFTS: Record<string, Action> = {

  // ═══════════════ 1 COIN: ANNOYANCE. Costs seconds. ═══════════════
  // Fires dozens of times per stream. One gift = one effect, never scaled up.

  // Single TNT from above. fuse 60 is 3.0s: time to sprint away, not a death sentence.
  // NOTE the lowercase key. `Fuse` was renamed to `fuse` in 1.20.3 (23w42a), so on
  // 26.2 the old capitalised form is silently ignored and TNT falls back to its
  // 80-tick (4.0s) default. That is why the launch gift never launched anything.
  rose: (n) => [banner('TNT', 'red'), ...rep(n, 1, at('summon tnt ~ ~ ~ {fuse:60}'))],

  // Lightning on the player's head. Visual noise, sets fire in dry biomes.
  tiktok: (n) => [banner('STRIKE', 'yellow'), ...rep(n, 1, at('summon lightning_bolt ~ ~ ~'))],

  // WEBBED. One cobweb for one gift; a streak grows a cobweb cube around the player.
  //
  // The old version was `rep(n, 1, setblock ~ ~ ~ cobweb)` capped at 15, which sent
  // fifteen setblocks at the SAME coordinate: fifteen gifts, one cobweb. Repeating a
  // command only multiplies the effect when the command creates something new, which
  // is why `summon` was the only entry that ever worked.
  //
  // Radius grows as sqrt(streak) and is capped at 2, so a 100x streak is a 5x3x5
  // pocket the player can chew out of in ~15s, not a tomb. `replace air` so it fills the space
  // around the player instead of eating the terrain, which would help them by
  // removing stone.
  gg: (n) => {
    const r = clamp(Math.floor(Math.sqrt(n)) - 1, 0, 2);   // 1-3 -> one web, 4-8 -> r1, 9+ -> r2
    return [
      banner('WEBBED', 'white'),
      r === 0
        ? at('setblock ~ ~ ~ cobweb')
        : at(`fill ~-${r} ~ ~-${r} ~${r} ~${r} ~${r} cobweb replace air`),
    ];
  },

  // THE WOBBLE. 15s of nausea. Nothing to fight, the screen just swims,
  // which reads instantly on a vertical crop.
  icecreamcone: () => [
    banner('WOOZY', 'light_purple'),
    `effect give ${MC_PLAYER} minecraft:nausea 15 0`,
  ],

  // HELP 1 of 4. Golden apple. At 1 coin it is a heal, not a rescue.
  // The count scales on the give ARGUMENT, not by repeating the command.
  // give past a full inventory drops at the player's feet, it does not void the item.
  heartme: (n) => [
    banner('GOLDEN APPLE', 'green'),
    `give ${MC_PLAYER} golden_apple ${clamp(n, 1, 8)}`,
  ],

  // ═══════════════ 5 TO 45 COINS: TIME LOSS. Costs about a minute. ═══════════════

  // THE SLUDGE. Mining fatigue III + slowness II for 20s. Everything takes three
  // times as long, and it reads because the player swings and blocks do not break.
  fingerheart: () => [
    banner('SLUDGE', 'green'),
    `effect give ${MC_PLAYER} minecraft:mining_fatigue 20 2`,
    `effect give ${MC_PLAYER} minecraft:slowness 20 1`,
  ],

  // LAUNCH. Resistance V first so the player takes the knockback and none of the
  // damage, then TNT one block under their feet on a 2-tick fuse.
  //
  // This is the gift that did nothing: the fuse key was capitalised, so the TNT
  // used its 4-second default and the player had always walked away by the time it
  // went off.
  // Lowercase `fuse` fixes it. The 5s resistance is deliberately NOT longer: it has
  // to outlive one explosion, and more would just be temporary invincibility.
  friendshipnecklace: () => [
    banner('LAUNCHED', 'gold'),
    `effect give ${MC_PLAYER} minecraft:levitation 1 20`,
    `effect give ${MC_PLAYER} minecraft:resistance 8 4`,
  ],

  // FLOAT. 20s of levitation, then the fall.
  // Amplifier is 0, not 1: at level 2 for 20s the player rises ~36 blocks and the
  // landing is lethal, and only 899+ gifts are allowed to kill. Level 1 is ~18 blocks.
  perfume: () => [
    banner('FLOAT', 'aqua'),
    `effect give ${MC_PLAYER} minecraft:levitation 20 0`,
  ],

  // BLACKOUT. Weather alone is not an effect, so the night ships with the mobs:
  // six hostiles on top of the player, and the darkness it sets keeps spawning
  // more until they fix it. That is the minute this tier is meant to cost.
  doughnut: () => [
    banner('BLACKOUT', 'blue'),
    'time set midnight',
    'weather thunder',
    ...ring(3, 4, (dx, dz) => at(`summon zombie ~${dx} ~ ~${dz}`)),
    ...ring(4, 2, (dx, dz) => at(`summon skeleton ~${dx} ~ ~${dz}`)),
  ],

  // ═══════════════ 99 TO 199 COINS: RESOURCE LOSS. Costs items and gear. ═══════════════
  // Nothing in this tier spawns anything. The full inventory wipe used to live here at
  // 99 coins and has been moved to `moneygun` (500): a total wipe is resource loss and
  // position loss at once, the most run-ending non-fatal effect in the game, so it is now
  // the most expensive thing that is not fatal. `handheart` holds BURIED in its place.

  // UPROOTED. A mini-relocate: 60 to 120 blocks, enough to lose the player's
  // bearings and
  // cost a minute or two of walking back, without corgi's five-minute march.
  //
  // This slot used to be a fourth inventory wipe. Three destruction gifts already
  // sit at 99-100 coins; a fourth would have made every gift in the band the same
  // coin flip. Position was the tier that needed the entries.
  papercrane: () => [
    banner('UPROOTED', 'gold'),
    at(`spreadplayers ${randomOffset(60, 120)} 0 25 false ${MC_PLAYER}`),
  ],

  // HOTBAR WIPE. Exactly the nine slots on the main bar, nothing else.
  // `clear` cannot target slots, so this is `item replace entity` per slot, which
  // can. Distinct from the gear wipe and the full wipe: the backpack survives and
  // whatever was actually in hand does not.
  hatandmustache: () => [
    banner('HOTBAR WIPED', 'red'),
    ...Array.from({ length: 9 }, (_, i) => `item replace entity ${MC_PLAYER} hotbar.${i} with air`),
  ],

  // GEAR GONE. Everything worn and every tool and weapon, equipped or stowed.
  // Absorbs what papercrane used to do to pickaxes.
  // Equipped slots go through `item replace` because that is deterministic;
  // the inventory copies go through explicit `clear` item IDs so no item tag has
  // to exist for the wipe itself to work. The armour tags are a bonus sweep for
  // spare pieces in the backpack.
  loveyou: () => [
    banner('GEAR GONE', 'red'),
    ...EQUIP_SLOTS.map((s) => `item replace entity ${MC_PLAYER} ${s} with air`),
    ...clearItems(ALL_TOOLS),
    ...clearItems(['bow', 'crossbow', 'trident', 'shield', 'elytra', 'turtle_helmet']),
    `clear ${MC_PLAYER} #minecraft:head_armor`,
    `clear ${MC_PLAYER} #minecraft:chest_armor`,
    `clear ${MC_PLAYER} #minecraft:leg_armor`,
    `clear ${MC_PLAYER} #minecraft:foot_armor`,
  ],

  // BURIED. The floor opens, the player falls 12 blocks, and 2.5s later the hole
  // seals overhead in stone. Because the seal is placed `at` the player it lands
  // wherever they actually came to rest.
  //
  // Key was `handhearts` (assumed 99). The CA gift is "Hand Heart", SINGULAR, at 100
  // coins, which normalizes to `handheart`. The plural key matched nothing, so BURIED
  // could never fire - and worse, the real 100-coin gift fell through to fallback(100),
  // which is the hotbar wipe. Sending Hand Heart printed HOTBAR WIPED. Caught by --keys.
  handheart: () => {
    later(2_500, [at('fill ~-2 ~1 ~-2 ~2 ~3 ~2 stone')]);
    return [
      banner('BURIED', 'white'),
      at('fill ~-1 ~-1 ~-1 ~1 ~-12 ~1 air'),
    ];
  },

  // HELP 2 of 4. SECOND WIND. Regeneration IV for a full minute.
  // No longer nether-specific: this is a genuine save at any point in the run,
  // whether the player is on fire, at half a heart, or mid-fight.
  //
  // Key history, and a lesson about how gifts get verified. `coffee` (30) was never a
  // CA gift at all. `bouncingball` (45) was, and has been retired. `fistbump` (90) was
  // a mistake: it was read off a gift panel by eye and it does not exist in this region
  // at all. Four sources agree on that - the June scrape, the streamtoearn CA page, the
  // account's own Viewer Wishes panel, and a --catalog capture of the live room.
  //
  // Now Flowers, present in the --catalog capture at exactly 100 coins.
  //
  // NOTE THE PRICE. At 100 this costs exactly what `handheart` (BURIED) costs and one
  // coin more than the two 99-coin punishments, so within this band price no longer
  // separates helping from hurting at all. The name, the icon and the overlay's colour
  // are the only things that do, which is precisely why the overlay has a verdict strip.
  // It is filed in the 99-199 block for price order, but the tier headings describe the
  // PUNISHMENT ladder. The four HELP gifts run alongside that ladder at 1, 100, 299 and
  // 699 rather than inside it, and this one shares its rung with BURIED.
  flowers: () => [
    banner('SECOND WIND', 'green'),
    `effect give ${MC_PLAYER} minecraft:regeneration 60 3`,
  ],

  // ═══════════════ 199 TO 699 COINS: POSITION LOSS. Costs progress. ═══════════════

  // PITFALL. The floor stops existing, 12 blocks straight down. Devastating on a
  // bridge, nearly free in a cave, so viewers learn to time it.
  // 5x12x5 = 300 blocks, well inside the 32768 fill limit.
  //
  // Key was `sunglasses` (199), retired since the June 2026 catalog. Now Balloons at
  // 200, confirmed in a live panel. One coin more, same band, same effect.
  balloons: () => [
    banner('FLOOR GONE', 'red'),
    at('fill ~-2 ~-1 ~-2 ~2 ~-12 ~2 air'),
  ],

  // RELOCATE. 150 to 400 blocks in a random direction. Five real minutes of
  // walking and instant visible panic.
  //
  // The offset is rolled here rather than left to spreadplayers, because
  // spreadDistance is the minimum gap BETWEEN players, not a distance from centre.
  // With one target it does nothing, so `spreadplayers ~ ~ 150 400` would happily
  // land the player 6 blocks away. maxRange 40 is only the scatter around that point.
  // spreadplayers still does the teleport because it lands on a safe surface,
  // which a raw tp does not. It can fail under the Nether roof.
  corgi: () => [
    banner('RELOCATED', 'red'),
    at(`spreadplayers ${randomOffset(150, 400)} 0 40 false ${MC_PLAYER}`),
  ],

  // HELP 3 of 4. THE IRON KIT. Full iron armour, sword and pickaxe.
  // The "finally, one nice thing" gift, and the answer to the wipes in the band below.
  //
  // Key history: `dancingflower` (199) was never a CA gift. `lovecall` (299) was, and
  // has since been retired. Now Cello Romance, also 299, confirmed in a live panel.
  // Effect and price unchanged from the gift it replaces.
  //
  // It sits level with `corgi` (299) rather than just above the 99-199 wipe band it
  // answers, and it is still the cheapest gear-restoring HELP in the map.
  celloromance: () => [
    banner('IRON KIT', 'aqua'),
    `give ${MC_PLAYER} iron_helmet 1`,
    `give ${MC_PLAYER} iron_chestplate 1`,
    `give ${MC_PLAYER} iron_leggings 1`,
    `give ${MC_PLAYER} iron_boots 1`,
    `give ${MC_PLAYER} iron_sword 1`,
    `give ${MC_PLAYER} iron_pickaxe 1`,
  ],

  // INVENTORY WIPED. Everything. `clear <player>` with no item argument empties
  // the whole inventory including armour and offhand. One command, total loss.
  // Moved up here from 99 coins: this is the most run-ending non-fatal gift in the map.
  moneygun: () => [
    banner('INVENTORY WIPED', 'red'),
    `clear ${MC_PLAYER}`,
  ],


  // HELP 4 of 4. THE DRAGON KIT. Eight beds is the actual meta for killing the
  // dragon, and the totem turns a death into a survival on camera.
  swan: () => [
    banner('DRAGON KIT', 'aqua'),
    `give ${MC_PLAYER} white_bed 7`,
    `give ${MC_PLAYER} totem_of_undying 2`,
  ],

  // ═══════════════ 899+ COINS: RUN THREAT. Costs potentially everything. ═══════════════
  // The only tier allowed to be reliably fatal.

  // SKY DIVE. 120 blocks straight up and no way down but down.
  train: () => [
    banner('SKY DIVE', 'red'),
    at(`tp ${MC_PLAYER} ~ ~120 ~`),
    at('playsound minecraft:entity.ghast.scream master @a ~ ~ ~ 1 0.7'),
  ],

  // WARDEN. Slow, effectively unkillable, and it despawns if the player gets away,
  // so it is a chase rather than a guaranteed death.
  // Darkness capped at 20s: the warden already tracks by sound, and blind plus
  // hunted for 45s is a black screen and a death message, not content.
  galaxy: () => [
    banner('WARDEN', 'aqua'),
    at('summon warden ~6 ~ ~'),
    `effect give ${MC_PLAYER} minecraft:darkness 20 0`,
  ],

  // ═══════════════ THE FINALE. 7,000 coins. ═══════════════
  // Key history: `rocket` (20,000) was never a CA gift. `reddevilcorgi` (20,000) was,
  // and has since been retired. Now Sports Car at 7,000, confirmed in a live panel.
  //
  // THE PRICE FELL BY TWO THIRDS. At 20,000 this fired approximately never; at 7,000
  // it is reachable, which changes what the sequence has to survive. It summons 20
  // withers and enqueues ~57 commands over nine seconds, and nothing in here stops a
  // second one starting while the first is still running. See docs/GOTCHAS.md.
  // Explicitly NOT a crash and NOT a kill: a crash is dead air and a possibly
  // corrupted world, and dying instantly is over before anyone looks up.
  // This is a nine-second staged sequence, and the player survives all of it.
  //
  // Resistance V, fire resistance and slow falling go on FIRST and outlast the
  // whole show, so the lightning and the drop cannot actually hurt them.
  // Deliberately built from particles, lightning and sound rather than
  // firework_rocket entities: fireworks need a nested item-component NBT blob to
  // produce any visible explosion, and that is exactly the kind of version-sensitive
  // structure that silently does nothing (see the fuse rename above).
  sportscar: () => {
    const boom = (r: number) => ring(r, 8, (dx, dz) => at(`summon lightning_bolt ~${dx} ~ ~${dz}`));
    const puff = (p: string, spread: number, count: number, y = 2) =>
      at(`particle minecraft:${p} ~ ~${y} ~ ${spread} ${spread} ${spread} 0.6 ${count} force`);

    later(2_000, [
      ...boom(7),
      at('playsound minecraft:entity.lightning_bolt.thunder master @a ~ ~ ~ 1 0.7'),
    ]);
    later(4_000, [
      puff('firework', 4, 500),
      puff('explosion_emitter', 3, 24),
      at('playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 0.5'),
    ]);
    later(6_000, [
      ...boom(4),
      puff('end_rod', 5, 600, 3),
      puff('totem_of_undying', 3, 400),
      at('playsound minecraft:item.totem.use master @a ~ ~ ~ 1 1'),
    ]);
    later(7_000, [
      ...ring(12, 20, (dx, dz) => at(`summon wither ~${dx} ~6 ~${dz}`)),
      banner('DEATH.', 'dark_red'),
    ]);
    later(9_000, [
      puff('firework', 6, 800, 4),
      at('playsound minecraft:ui.toast.challenge_complete master @a ~ ~ ~ 1 1'),
      `title ${MC_PLAYER} subtitle {"text":"7,000 coins","color":"yellow"}`,
      `title ${MC_PLAYER} title {"text":"THE FINALE","color":"gold","bold":true}`,
    ]);

    return [
      banner('THE FINALE', 'gold'),
      `effect give ${MC_PLAYER} minecraft:resistance 30 4`,
      `effect give ${MC_PLAYER} minecraft:fire_resistance 30 0`,
      `effect give ${MC_PLAYER} minecraft:slow_falling 30 0`,
      'weather clear',
      'time set midnight',
      `effect give ${MC_PLAYER} minecraft:levitation 6 1`,
      at('playsound minecraft:entity.ender_dragon.death master @a ~ ~ ~ 1 0.6'),
    ];
  },
};

// Unmapped gift: scale by total coin value so a big gift still does something.
// Tiers reuse the mapped entries so the two can never drift apart.
//
// This is the safety net for the thing that just happened: the named gifts in GIFTS are
// what goes on an on-screen graphic, and TikTok retires and renames them without notice.
// A gift that has fallen out of the map still produces an effect proportional to what it
// cost, so a retired key degrades the show rather than breaking it. The top tier tracks
// the finale's real price, so a gift big enough to buy the finale gets the finale rather
// than dropping into the middle of the ladder.
export function fallback(coins: number): string[] {
  if (coins >= 7000) return GIFTS.sportscar(1);     // the finale
  if (coins >= 899)  return GIFTS.galaxy(1);        // run threat: warden
  if (coins >= 299)  return GIFTS.corgi(1);         // position: relocate
  if (coins >= 199)  return GIFTS.balloons(1);      // position: pitfall
  if (coins >= 99)   return GIFTS.hatandmustache(1); // resource: hotbar wipe
  if (coins >= 20)   return GIFTS.perfume(1);       // time: float
  if (coins >= 5)    return GIFTS.fingerheart(1);   // time: sludge
  return GIFTS.rose(1);                             // annoyance: one TNT
}

// ---------- price-gated keys ----------
// `key()` lowercases and strips separators, so two DIFFERENT gifts can collapse onto the
// same key. CA ships "Love you" at 1 coin AND "Love You" at 199; both normalize to
// `loveyou`, and nothing in the payload distinguishes them except the price. Before this
// table a 1-coin "Love you" fired the 47-command GEAR GONE strip - a tier-3 punishment on
// a tier-1 spam gift, several times a minute on a busy stream.
//
// A key listed here is resolved by COIN VALUE, not by name alone. Variants are tried
// highest `minCoins` first and the first one the gift can afford wins. A gift that
// affords none of them falls through to `fallback()`, which is exactly the treatment an
// unmapped gift gets - the right answer for the cheap twin of an expensive gift.
// `action` is optional: omit it to use the body already sitting in GIFTS under this key.
//
// The gate compares against the gift's UNIT price (`diamondCount`), never the streak
// total. A 199x streak of the 1-coin "Love you" is still the 1-coin gift and must not
// buy the 199-coin effect.
//
// Deliberately generic rather than a special case: the CA catalog has 553 gifts and this
// will not be the last collision. `--keys` finds them - a mapped key with two catalog
// prices and no entry here is a --keys failure.

export const PRICED: Record<string, PricedVariant[]> = {
  // "Love You" (199) -> GEAR GONE.  "Love you" (1) -> fallback(1), i.e. one TNT.
  loveyou: [{ minCoins: 199 }],

  // The panel sells TWO gifts called "Sports Car", at 4,999 and 7,000, and both
  // normalize to `sportscar`. Ungated, the cheaper one bought the finale for 2,000
  // coins less than intended. Only the 7,000 one fires it now; 4,999 falls through to
  // fallback(4999), which is the 899+ tier, the warden. Found by --keys against a fresh
  // --catalog capture: the June scrape listed only one Sports Car.
  sportscar: [{ minCoins: 7000 }],
};

