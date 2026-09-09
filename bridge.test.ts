/**
 * bridge.test.ts - offline tests for the logic that has produced the most bugs.
 *
 *   npm test
 *
 * No server, no network, no TikTok account, no .env. Runs in well under a second, which
 * is the point: this is the check you can afford to run on every edit and in CI.
 *
 * What is deliberately NOT in here, because neither can run offline:
 *   --verify  asks "is this valid Minecraft on this server version?"  Needs a server.
 *   --keys    asks "does this gift exist in my region at this price?" Needs a catalog.
 * Those two check the map against the world. These check the logic against itself, and
 * the three axes do not overlap. Run all three before a stream.
 *
 * Every case below is a bug that actually shipped, or the boundary next to one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  cancelPendingStages,
  catalogAgeDays,
  catalogAge,
  normalizeCatalogGifts,
  pendingStageSummary,
  resolve,
  sanitize,
  scheduleStage,
} from './bridge';
import { ASSUMED_COINS, GIFTS, PRICED, fallback } from './gift-map';
import { installScheduler, key, later, rep, type Deferred } from './gift-helpers';

// Importing bridge.ts installs the real scheduler, which would leave up to nine seconds
// of live timers behind after a test touches the finale. Replace it with a collector.
// This also makes the delayed stages of a gift observable, which is the whole reason
// later() is a hole the caller fills.
const deferred: Deferred[] = [];
const collect = (ms: number, cmds: string[]) => { for (const cmd of cmds) deferred.push({ ms, cmd }); };
installScheduler(collect);
const takeDeferred = (): Deferred[] => deferred.splice(0);

/** The uppercase word a gift announces itself with. Deterministic, unlike its commands. */
const bannerOf = (cmds: string[]): string => {
  const m = /^tellraw @a \{"text":"([^"]*)"/.exec(cmds[0] ?? '');
  return m ? m[1] : `(no banner in: ${cmds[0] ?? 'nothing at all'})`;
};

const C = String.fromCharCode;
const P = String.fromCodePoint;

// ---------------------------------------------------------------- key()

test('key() collapses the spellings a gift name arrives in', () => {
  assert.equal(key('Finger Heart'), 'fingerheart');
  assert.equal(key('FINGER HEART'), 'fingerheart');
  assert.equal(key('fingerheart'), 'fingerheart');
  assert.equal(key("It's Match Time"), 'itsmatchtime');
  assert.equal(key('Rose ' + P(0x1F339)), 'rose');
  assert.equal(key(''), '');
});

test('key() keeps singular and plural APART, which is how BURIED was dead for weeks', () => {
  // The CA gift is "Hand Heart", singular. The map said `handhearts`, so the effect
  // could never fire and the real gift fell through to the hotbar wipe instead.
  assert.equal(key('Hand Heart'), 'handheart');
  assert.equal(key('Hand Hearts'), 'handhearts');
  assert.notEqual(key('Hand Heart'), key('Hand Hearts'));
});

test('key() collapses two DIFFERENT gifts onto one key, which is why PRICED exists', () => {
  // "Love you" is 1 coin and "Love You" is 199. Nothing but the price tells them apart.
  assert.equal(key('Love you'), key('Love You'));
  assert.equal(key('Love you'), 'loveyou');
});

// ---------------------------------------------------------------- map integrity

test('every gift in the map declares what it costs', () => {
  // --keys checks these against a real catalog. This checks the table is complete at
  // all, which --keys cannot do offline and which is the cheaper half of that check.
  for (const k of Object.keys(GIFTS)) {
    assert.equal(typeof ASSUMED_COINS[k], 'number', `${k} has no ASSUMED_COINS entry`);
    assert.ok(ASSUMED_COINS[k] > 0, `${k} has a non-positive assumed price`);
  }
});

test('every PRICED key can actually resolve to a body', () => {
  for (const [k, variants] of Object.entries(PRICED)) {
    assert.ok(variants.length > 0, `PRICED["${k}"] is empty`);
    const usable = k in GIFTS || variants.every((v) => typeof v.action === 'function');
    assert.ok(usable, `PRICED["${k}"] has no GIFTS body and no action of its own`);
  }
});

// ---------------------------------------------------------------- resolve()

test('resolve() maps a known gift, whatever case it arrives in', () => {
  assert.equal(bannerOf(resolve('Rose', 1, 1)), 'TNT');
  assert.equal(bannerOf(resolve('rose', 1, 1)), 'TNT');
  assert.equal(bannerOf(resolve('R O S E', 1, 1)), 'TNT');
  assert.equal(resolve('Rose', 1, 1).length, 2, 'banner plus one summon');
});

test('resolve() scales a streak on the gifts that can be repeated', () => {
  // Repetition only multiplies commands that CREATE something. summon does.
  assert.equal(resolve('Rose', 12, 1).length, 13, 'banner plus twelve summons');
  assert.equal(resolve('Rose', 1, 1).length, 2);
});

test('resolve() falls back for a gift nobody mapped', () => {
  assert.equal(bannerOf(resolve('Some Gift That Does Not Exist', 1, 1)), 'TNT');

  // An unmapped gift gets the TIER its coin value buys, not the effect that a mapped
  // gift at the same price happens to have. 500 coins is the 299+ tier, RELOCATED.
  // The mapped 500-coin gift, moneygun, is INVENTORY WIPED and is a different thing.
  assert.equal(bannerOf(resolve('Some Gift That Does Not Exist', 1, 500)), 'RELOCATED');
  assert.equal(bannerOf(GIFTS.moneygun(1)), 'INVENTORY WIPED');
});

test('resolve() gates the loveyou collision on the UNIT price, never the streak total', () => {
  // The bug: a 1-coin "Love you", which viewers spam, fired the 47-command strip meant
  // for the 199-coin "Love You".
  assert.equal(bannerOf(resolve('Love You', 1, 199)), 'GEAR GONE');
  assert.equal(bannerOf(resolve('Love you', 1, 1)), 'TNT', 'the 1-coin twin gets fallback(1)');

  // A streak that has delivered 199 coins gets what 199 coins buys in the tier table,
  // exactly as any unmapped gift would - but it must NOT buy the gated body.
  assert.equal(bannerOf(resolve('Love you', 50, 1)), 'FLOAT', 'fallback(50)');
  assert.equal(bannerOf(resolve('Love you', 199, 1)), 'FLOOR GONE', 'fallback(199)');
  assert.notEqual(
    bannerOf(resolve('Love you', 199, 1)),
    'GEAR GONE',
    'a 199x streak of a 1-coin gift must not buy the 199-coin effect',
  );
});

// ---------------------------------------------------------------- fallback()

test('fallback() tier boundaries, both sides of every edge', () => {
  const edges: Array<[number, string]> = [
    [0, 'TNT'],
    [4, 'TNT'],
    [5, 'SLUDGE'],
    [19, 'SLUDGE'],
    [20, 'FLOAT'],
    [98, 'FLOAT'],
    [99, 'HOTBAR WIPED'],
    [198, 'HOTBAR WIPED'],
    [199, 'FLOOR GONE'],
    [298, 'FLOOR GONE'],
    [299, 'RELOCATED'],
    [898, 'RELOCATED'],
    [899, 'WARDEN'],
    [6999, 'WARDEN'],
    [7000, 'THE FINALE'],
  ];
  for (const [coins, expected] of edges) {
    assert.equal(bannerOf(fallback(coins)), expected, `fallback(${coins})`);
  }
  takeDeferred();   // the finale registered delayed stages; do not leak them into the next test
});

// ---------------------------------------------------------------- sanitize()

test('sanitize() holds against everything a nickname can contain', () => {
  // A nickname is chosen by a viewer and is interpolated straight into tellraw JSON.
  // The two characters that could break out are " and \. Everything outside the
  // allowlist goes, so the list below is what survives, not what is filtered.
  const cases: Array<[string, string, string]> = [
    ['quote injection', 'a","color":"red","bold":true,"x":"', 'acolorredboldtruex'],
    ['backslash',       'a\\"b\\\\c',                          'abc'],
    ['brace bracket',   '{"text":"pwned"}[]',                  'textpwned'],
    ['emoji',           'Player ' + P(0x1F389) + P(0x1F525) + ' stream', 'Player  stream'],
    ['RTL override',    'abc' + C(0x202E) + 'def' + C(0x200F) + C(0x200E), 'abcdef'],
    ['zero width',      'a' + C(0x200B) + 'b' + C(0x200C) + 'c' + C(0xFEFF) + 'd', 'abcd'],
    ['newline CR tab',  'line1\nline2\r\ntab\tend',            'line1line2tabend'],
    ['null byte',       'a' + C(0) + ' b',                     'a b'],
    ['section sign',    C(0xA7) + 'cRED' + C(0xA7) + 'r',      'cREDr'],
    ['ampersand',       '&cRED &lBOLD',                        'cRED lBOLD'],
    ['astral letters',  P(0x10400).repeat(30),                 P(0x10400).repeat(24)],
    ['CJK',             P(0x4E2D) + P(0x6587) + P(0x30C6),     P(0x4E2D) + P(0x6587) + P(0x30C6)],
    ['arabic',          P(0x0645) + P(0x0631) + P(0x062D),     P(0x0645) + P(0x0631) + P(0x062D)],
    ['combining marks', 'a' + C(0x0301) + C(0x0302) + ' name', 'a name'],
    ['long ascii',      'x'.repeat(200),                       'x'.repeat(24)],
    ['only symbols',    '!!!@@@###',                           'someone'],
    ['empty',           '',                                    'someone'],
    ['spaces only',     '     ',                               'someone'],
    ['selector-ish',    '@a[tag=x]',                           'atagx'],
    ['command-ish',     '/op someone',                         'op someone'],
  ];

  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  for (const [label, input, expected] of cases) {
    const out = sanitize(input);
    assert.equal(out, expected, `sanitize(${label})`);
    assert.ok(!out.includes('"'), `${label}: a quote survived`);
    assert.ok(!out.includes('\\'), `${label}: a backslash survived`);
    assert.ok(out.length > 0, `${label}: empty output, should have fallen back to "someone"`);
    assert.ok([...out].length <= 24, `${label}: longer than 24 code points`);
    assert.ok(!loneSurrogate.test(out), `${label}: cut a surrogate pair in half`);

    // The real test: it has to survive being pasted into the command we actually send.
    const cmd = `tellraw @a {"text":"${out} sent a gift x1","color":"gray"}`;
    assert.doesNotThrow(() => JSON.parse(cmd.slice(cmd.indexOf('{'))), `${label}: broke the tellraw JSON`);
  }
});

// ---------------------------------------------------------------- rep()

test('rep() caps a streak so one viewer cannot enqueue the world', () => {
  assert.equal(rep(1000, 1, 'summon lightning_bolt ~ ~ ~').length, 40, 'default cap');
  assert.equal(rep(5, 1, 'summon lightning_bolt ~ ~ ~').length, 5);
  assert.equal(rep(3, 1, 'summon lightning_bolt ~ ~ ~', 2).length, 2, 'explicit cap');
  assert.equal(rep(0, 1, 'summon lightning_bolt ~ ~ ~').length, 1, 'never zero commands');
  assert.equal(rep(-4, 1, 'summon lightning_bolt ~ ~ ~').length, 1, 'never negative');
});

test('rep() warns once when handed a command that repeating cannot multiply', () => {
  // fifteen setblocks at the same coordinate is fifteen commands and one cobweb.
  const seen: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { seen.push(a.join(' ')); };
  try {
    const cmd = 'setblock ~ ~ ~ test_block_for_the_warning_case';
    const out = rep(3, 1, cmd);
    assert.equal(out.length, 3, 'it still returns what it was asked for');
    rep(3, 1, cmd);            // same command again
    rep(3, 1, 'summon pig');   // repeatable, no warning
  } finally {
    console.warn = realWarn;
  }
  assert.equal(seen.length, 1, 'exactly one warning, deduped by command');
  assert.match(seen[0], /collapse to one effect/);
});

// ---------------------------------------------------------------- later()

test('later() hands delayed commands to whatever scheduler the caller installed', () => {
  takeDeferred();
  later(1234, ['first', 'second']);
  assert.deepEqual(takeDeferred(), [
    { ms: 1234, cmd: 'first' },
    { ms: 1234, cmd: 'second' },
  ]);
});

test('the gifts with delayed stages actually register them', () => {
  // The bug this guards: later() used to drop its payload under --verify, so the whole
  // finale and the buried gift's seal were never checked and the run still said 123/123.
  takeDeferred();

  GIFTS.handheart(1);
  const buried = takeDeferred();
  assert.equal(buried.length, 1, 'BURIED schedules exactly one command, the stone seal');
  assert.equal(buried[0].ms, 2_500);

  GIFTS.sportscar(1);
  const finale = takeDeferred();
  assert.ok(finale.length >= 40, `the finale should stage dozens of commands, got ${finale.length}`);
  assert.deepEqual(
    [...new Set(finale.map((d) => d.ms))].sort((a, b) => a - b),
    [2_000, 4_000, 6_000, 7_000, 9_000],
    'the finale is a five-stage sequence',
  );
});

// ---------------------------------------------------------------- pending stages

test('the real scheduler tracks a delayed stage until it has fired', async () => {
  // The bug: every mode stopped as soon as the command queue was empty, which is
  // before a stage scheduled seconds later can fire. --replay could not replay BURIED
  // or the finale at all, and said nothing about dropping them. Shutdown now knows
  // what is outstanding, which is what makes both waiting and warning possible.
  installScheduler(scheduleStage);   // the real one, in place of this file's collector
  try {
    assert.equal(pendingStageSummary().stages, 0, 'nothing outstanding to start with');

    later(60, ['one', 'two']);

    const pending = pendingStageSummary();
    assert.equal(pending.stages, 1, 'one later() call is one stage');
    assert.equal(pending.commands, 2, 'carrying two commands');
    assert.ok(pending.longestMs > 0, 'and it has not fired yet');
    assert.ok(pending.longestMs <= 60, `longestMs should be the real offset, got ${pending.longestMs}`);

    await sleep(150);
    assert.equal(pendingStageSummary().stages, 0, 'the stage clears itself once it fires');
    assert.equal(pendingStageSummary().commands, 0);
  } finally {
    installScheduler(collect);
  }
});

test('a multi-stage gift is outstanding as a whole, not one stage at a time', async () => {
  installScheduler(scheduleStage);
  try {
    GIFTS.sportscar(1);
    const pending = pendingStageSummary();
    assert.equal(pending.stages, 5, 'the finale is five stages');
    assert.ok(pending.commands >= 40, `and dozens of commands, got ${pending.commands}`);
    assert.ok(
      pending.longestMs > 8_000 && pending.longestMs <= 9_000,
      `the last stage is about nine seconds out, got ${pending.longestMs}ms`,
    );
  } finally {
    // Without this the suite would sit here for nine seconds waiting on the finale's
    // timers, which is exactly the wait --replay now does deliberately and a test
    // should not.
    cancelPendingStages();
    installScheduler(collect);
    takeDeferred();
  }
});

// ---------------------------------------------------------------- catalog

test('normalizeCatalogGifts() reads the spellings the panel has actually used', () => {
  // The library types the gift list as `any`, and this project has been bitten twice by
  // field paths moving between versions. TikTok's own gift/list/ endpoint is snake_case
  // and is passed through unrenamed; other shapes in the same SDK are camelCase.
  const snake = [{ name: 'Rose', diamond_count: 1 }, { name: 'Sports Car', diamond_count: 7000 }];
  const camel = [{ giftName: 'Rose', diamondCount: 1 }, { giftName: 'Sports Car', diamondCount: 7000 }];
  const gallery = [{ name: 'Rose', coin_price: 1 }, { name: 'Sports Car', coin_price: 7000 }];
  const expected = [{ name: 'Rose', coins: 1 }, { name: 'Sports Car', coins: 7000 }];

  assert.deepEqual(normalizeCatalogGifts(snake), expected);
  assert.deepEqual(normalizeCatalogGifts(camel), expected);
  assert.deepEqual(normalizeCatalogGifts(gallery), expected);

  // and the wrappers a future version might hand back instead of a bare array
  assert.deepEqual(normalizeCatalogGifts({ gifts: snake }), expected);
  assert.deepEqual(normalizeCatalogGifts({ data: { gifts: snake } }), expected);
});

test('normalizeCatalogGifts() sorts, so a refreshed catalog diffs cleanly', () => {
  const out = normalizeCatalogGifts([
    { name: 'Sports Car', diamond_count: 7000 },
    { name: 'Rose', diamond_count: 1 },
    { name: 'Balloons', diamond_count: 200 },
  ]);
  assert.deepEqual(out.map((g) => g.name), ['Rose', 'Balloons', 'Sports Car']);
});

test('normalizeCatalogGifts() REFUSES a shape it does not understand', () => {
  // Writing a catalog it could not read would be worse than writing none: the catalog
  // is the file every other check trusts. It has to fail loudly, naming the real keys.
  assert.throws(() => normalizeCatalogGifts(null), /could not find a gift array/);
  assert.throws(() => normalizeCatalogGifts([]), /could not find a gift array/);
  assert.throws(() => normalizeCatalogGifts({ nope: 1 }), /object with keys: nope/);
  assert.throws(
    () => normalizeCatalogGifts([{ gift_title: 'Rose', price_in_coins: 1 }]),
    /Keys on the first entry: gift_title, price_in_coins/,
  );
});

test('catalogAge() reports the age of the DATA, not of the file', () => {
  const now = Date.parse('2026-09-09T00:00:00Z');
  // The exact trap the shipped catalog fell into: its header was rewritten in September
  // while the gift list in it was still June's. The file looked one day old and was not.
  assert.deepEqual(
    catalogAge({ capturedAt: '2026-09-08', catalogUpdated: 'June 23, 2026' }, now),
    { days: 78, date: 'June 23, 2026' },
  );
  assert.deepEqual(catalogAge({ capturedAt: '2026-09-09' }, now), { days: 0, date: '2026-09-09' });
  assert.equal(catalogAge({}, now), null, 'no dates at all is not the same as fresh');
  assert.equal(catalogAge({ capturedAt: 'sometime' }, now), null);
});

test('catalogAgeDays() is what makes staleness visible', () => {
  const now = Date.parse('2026-09-09T00:00:00Z');
  assert.equal(catalogAgeDays('2026-09-09', now), 0);
  assert.equal(catalogAgeDays('2026-09-08', now), 1);
  assert.equal(catalogAgeDays('2026-06-23', now), 78, 'the drift that cost four gifts');
  assert.equal(catalogAgeDays(undefined, now), null, 'no date means no answer, not zero');
  assert.equal(catalogAgeDays('not a date', now), null);
});
