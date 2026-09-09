# Gotchas

Every entry here is a bug that shipped and ran undetected, most of them for weeks. They
share a shape: **the failure is silent**. Nothing throws, nothing logs, `--verify` prints
a green line, and the only symptom is that an effect quietly does nothing while the stream
carries on.

If you write your own gifts, this file will save you more time than the rest of the repo
combined.

---

## 1. Entity NBT keys get renamed, and the old name is silently ignored

`Fuse` on primed TNT was renamed to `fuse` in Minecraft 1.20.3 (snapshot 23w42a).

The capitalised form did not become an error. Entity NBT is parsed as generic SNBT, so
`{Fuse:60}` is still perfectly valid syntax; the server just finds no key it recognises,
ignores it, and the TNT falls back to its default 80-tick (4.0 second) fuse. The command
parses. `--verify` passes it. `--test` "works".

The only symptom was that the launch gift never launched anything: by the time the TNT
went off, four seconds later, the player had walked away.

**Why it is dangerous:** this is the one failure class `--verify` structurally cannot
catch. Verification proves a command *parses*, and a command with a misspelled NBT key
parses fine.

**What to do:** confirm entity NBT by observed behaviour, never by a green verify line.
Time the effect, watch the entity. If a gift's whole point is inside an NBT blob, fire it
in `--test` and look at it.

**Related:** the finale is built from particles, lightning and sound rather than
`firework_rocket` entities for exactly this reason. Fireworks need a nested
item-component NBT structure to produce any visible explosion, which is the most
version-sensitive thing in the command set and fails in precisely this silent way.

## 2. `@s` does not exist inside `execute at <player> run` over RCON

`execute at <player> run tp @s ~ ~120 ~` looks correct and cannot work.

`at` changes the **position** context. It does not change the **executor**. Over RCON the
executor is the server console, and the console is not an entity, so `@s` resolves to
nothing.

**What to do:** name the player explicitly in every command inside an `at()` wrapper:

```
execute at PlayerName run tp PlayerName ~ ~120 ~
```

This is why `at()` in `gift-helpers.ts` exists and why the map interpolates `MC_PLAYER`
into commands that already sit inside it. It looks redundant. It is not.

The same logic explains a subtler trap: a bare `~ ~` in an RCON command with no `at()`
wrapper is not the player's position, it is **world origin**. Commands that look
player-relative will happily fire at spawn.

## 3. `spreadplayers`' second number is not a radius

The signature is:

```
spreadplayers <center> <spreadDistance> <maxRange> <respectTeams> <targets>
```

`spreadDistance` is the **minimum distance between the players being spread**, not a
distance from the centre point. With a single target there are no other players to be
distant from, so it constrains nothing.

`spreadplayers ~ ~ 150 400 false PlayerName` reads like "teleport 150 to 400 blocks away"
and will cheerfully drop the player six blocks from where they were standing.

**What to do:** roll the offset in code and pass a small `maxRange` for local scatter:

```
execute at PlayerName run spreadplayers ~213 ~-88 0 40 false PlayerName
```

`spreadplayers` is still the right command rather than a raw `tp`, because it lands the
player on a safe surface. A `tp` will bury them in stone. It can fail under the Nether
roof, which is a fair trade.

## 4. Repeating a command does not multiply its effect

Repetition only multiplies things that **create something new**. `summon`, `particle` and
`playsound` produce a new entity, a new burst, a new sound each time.

`setblock`, `fill`, `effect give`, `give` and `item replace` all address the same block,
the same player, or the same slot every time. Fifteen copies collapse into exactly one
effect.

This shipped as `rep(n, 1, 'setblock ~ ~ ~ cobweb')` capped at 15: fifteen gifts in a
streak, fifteen commands sent, one cobweb. Every one of them was valid and every one of
them succeeded.

**What to do:** scale non-creating commands on their own arguments instead. A streak
should grow the *radius* of a `fill`, or the *count* argument of a `give`, not the number
of commands. `rep()` now warns once per distinct command when it is handed something
non-repeatable, which is a guardrail, not a fix.

## 5. A verify path that skips work reports a pass for the work it skipped

Commands scheduled for later (a cleanup pass, a staged sequence) do not exist at the
moment verification runs. An early version of `later()` simply returned during `--verify`,
so every delayed stage was dropped on the floor and never checked.

The output looked perfect: `123/123 passed`. The entire finale after its first stage,
48 commands of it, had never been parsed by the server at all. The highest-risk part of
the map was the only part nobody was checking.

**What to do:** during verification, collect the delayed payloads instead of scheduling
them, and check them in the same pass. Then print how many were collected, and treat a
count of zero as a **loud warning rather than a clean run**:

```
[verify] WARNING: no later() payloads were collected. Delayed stages are NOT being
checked - the collector is broken, this is not a clean run.
```

Generalise it beyond this project: any check with a shortcut in it reports success for
whatever the shortcut skipped. Make the skip visible in the output, or the output is a
lie.

## 6. Minecraft answers a bad command with text, not an error

Over RCON, a command the server rejects does not reject the promise or return a failure
code. The server sends back a normal reply whose *body* happens to be
`Unknown or incomplete command`, or `Incorrect argument for command`, with a
`<--[HERE]` marker pointing at the offending token.

Code that ignores RCON replies therefore sees every command succeed. That is how a
single typo does nothing for an entire stream while the console prints nothing but
success.

**What to do:** read every reply and pattern-match the error prefixes
(`Unknown`, `Incorrect`, `Expected`, `Invalid`, `Unable`, `Could not`, `Failed`,
`No … were found`, `That player`) plus `<--[HERE]`. Count the rejections and print the
first instance of each distinct command, deduplicated so one bad gift in a streak does
not flood the console.

An exception that *does* reject the promise means something different: the link is gone
or timed out, not that the command was bad. Those two need different handling. One is a
reconnect, the other is a bug in the map.

## 7. Gift names and prices are region-specific

A gift catalog is per region. A gift that exists in one country may not exist in another,
at all, and the ones that do exist can be priced differently.

Four map keys in this project were dead for weeks because the gifts they named do not
exist in the streamer's region: `coffee`, `dancingflower`, `rocket` and `handhearts`. One
of them was the 20,000-coin finale, the single most expensive thing in the map. It could
never have fired.

Then it happened a second time, the other way round, and that is the version worth
understanding, because the first fix did not prevent it. The catalog was a dated scrape
of a third-party website. Three months later four *different* mapped gifts had been
retired from the real panel while the file still listed them at their old prices, so
`--keys` compared the map against a photograph and reported clean on four effects that
could no longer fire. **A stale catalog does not fail. It agrees with you.**

**What to do:** check against the panel, not a copy of it. `--catalog` connects to a live
room and writes the gift list the room itself reports, for the right region, as of now.
Run it while you are live, then run `--keys`. `--keys` also warns when the file it is
reading is more than about a month old, because a clean result on a stale file means
very little.

**And keep the safety net.** `fallback()` scales an unmapped gift by its coin value, so a
gift that has quietly fallen out of the map still produces something proportional
instead of nothing. Named gifts are what goes on an on-screen graphic; the coin tiers
are what keeps the show working when a name changes underneath you.

**Why it is invisible:** an unmapped gift does not error. It falls through to the
coin-value fallback, which does something plausible for that price tier. A viewer sends
the 100-coin gift, an effect happens, everybody assumes it was the mapped one. The
100-coin gift in this map was silently running the hotbar wipe instead of the effect it
was supposed to run, and the announcement banner said so, and nobody noticed.

**What to do:** check every key against a real catalog for the region being streamed to.
That is what `--keys` does, and it is why it exists. Regenerate the catalog before any
stream where balance matters; prices drift.

## 8. Two different gifts can normalize to the same key

Gift names get normalized to match them robustly: lowercased, with everything that is not
a letter or a digit stripped. "Finger Heart", "finger heart" and "FingerHeart" all become
`fingerheart`, which is the whole point.

It also means two genuinely different gifts can collapse onto one key. The Canadian
catalog sells **"Love you" at 1 coin** and **"Love You" at 199 coins**. Both normalize to
`loveyou`, and nothing in the payload distinguishes them except the price.

The 1-coin gift, which viewers spam several times a minute, was firing the 47-command
strip-all-gear effect meant for the 199-coin one.

**What to do:** gate collided keys on price. `PRICED` in `gift-map.ts` maps a key to
variants with a minimum coin value; the highest one the gift can afford wins, and a gift
that affords none falls through to the fallback, which is the right treatment for the
cheap twin of an expensive gift.

Gate on the **unit price**, never the streak total. A 199x streak of a 1-coin gift has
delivered 199 coins but it is still the 1-coin gift, and it must not buy the 199-coin
effect.

`--keys` reports any mapped key with two catalog prices and no price gate as a failure.
Two catalog rows with the same name *and* the same price are just a duplicate listing and
are ignored.

## 9. `--verify` and `--keys` catch disjoint failures

They sound like two flavours of the same check. They are not, and neither substitutes for
the other:

| | Question it answers | Needs | Blind to |
|---|---|---|---|
| `--verify` | Is this valid Minecraft, on this server version? | a running server | whether a key can ever be reached; renamed NBT keys |
| `--keys` | Can this key ever fire, at the price assumed? | nothing, offline | whether the commands are valid at all |

A map can be 100% verified and half unreachable. A map can be 100% reachable and full of
commands the server rejects. Run both, every time, and then run `--test` for the gifts
whose *behaviour* rather than syntax is the point.

---

## Smaller traps, same shape

**Streakable gifts fire on every tick of the streak.** A gift with `type === 1` sends a
repeated event as the viewer holds the button. Acting on each one turns a single spammed
rose into thirty separate triggers. Wait for the end-of-streak flag and act once, using
the final repeat count.

**Two reconnect chains are worse than none.** A drain loop that reconnects when it finds
the link down, plus a retry timer that also reconnects, will fan a single outage out into
a dozen parallel connection attempts. One flag guarding "a retry is already scheduled"
fixes it. The same applies to any self-healing link with more than one thing watching it.

**A full queue is measured in seconds, not commands.** A backlog cap of 120 commands
draining at 8 per second is fifteen seconds of lag between a viewer's gift and the effect,
which on stream reads as the bridge being broken. Size the queue by how stale a command is
allowed to be, give queued commands a time-to-live, and drop them rather than firing them
late.

**`give` past a full inventory drops items at the player's feet.** It does not void them,
so a "gift" of items to a full inventory becomes a pile on the floor rather than nothing.

**Nothing checks that the banner matches the body.** Each gift announces itself in chat
before running its commands. The announcement is a separate string from the effect, and
rearranging the map can leave a gift printing `BURIED` while it wipes an inventory. No
tool in this repo catches that. Re-read the pair by eye after any rebalance.

**Prices in comments drift from prices in code.** `ASSUMED_COINS` is a real table that
`--keys` reads. The prose in the comments is not parsed and never will be: pulling coin
values out of English sentences with a regex is not a check worth trusting. The table
declares what a gift costs, the comment explains why it matters, and only the table is
verified. Keep them in step by hand.

**The scrape has to come from a rendered browser.** The gift catalog page is not
retrievable with an HTTP client - plain requests get a 403, and tools that summarise pages
truncate this one around 499 coins and then report every gift above that as *absent*.
That failure produced a confident, wrong answer: five gifts that exist were reported as
missing from the region, including the finale. A confident wrong answer is worse than an
error, because nothing prompts you to check. `catalog-scrape.js` is a browser-console
snippet for this reason, and it throws if it parses fewer than 100 gifts.

**A check nobody has seen fail is not a check.** Both `--keys` and `--verify` were proved
by deliberately breaking the map - reintroducing a dead key, removing a price gate,
setting a wrong coin value - and confirming each was reported and that the exit code was
1. Do that to your own checks before trusting a green run.
