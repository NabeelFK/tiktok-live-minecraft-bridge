# TikTok LIVE -> Minecraft bridge

Viewers send gifts on a TikTok LIVE stream and the gift fires a Minecraft command a
second later: TNT under the streamer, a warden, a wiped inventory, a full nine-second
finale. It is a Node process that listens to a TikTok LIVE room and pushes commands into
a local Minecraft server over RCON, so it needs no mods, no plugins and no datapack.

Built for a "beat Minecraft while chat interferes" stream, but the gift map is a plain
config file: swap the commands and it is a different show.

---

## Architecture

Three processes run at the same time, on one machine:

```
   TikTok LIVE room
          |
          |  websocket, handshake signed by Euler Stream
          v
   bridge.ts  (Node, run with tsx)          <- this repo
          |
          |  RCON, 127.0.0.1:25575
          v
   Paper server  (headless Minecraft server, holds the world)
          ^
          |  the normal game connection, 127.0.0.1:25565
          |
   Minecraft Java client  (you, playing, joined via Direct Connection)
```

1. **The Paper server** owns the world and does the work. It is a plain Minecraft server
   with RCON switched on, running in its own terminal.
2. **Your Minecraft client** is an ordinary Java Edition client that joins `localhost`.
   You are just a player on the server. Nothing is installed into the client.
3. **The bridge** connects outwards to TikTok and inwards to RCON. It never touches the
   client. Every effect you see happens because a command was run on the server.

The bridge is the only piece in this repo. The other two are Minecraft, and
[docs/SETUP.md](docs/SETUP.md) sets them up from nothing.

### Files

| File | What it is |
|---|---|
| `bridge.ts` | The engine: connection handling, the rate-limited command queue, and every mode. |
| `bridge.test.ts` | Offline tests for the logic that has produced the most bugs. `npm test`. |
| `env.ts` | Loads `.env` and resolves the four configuration values. Everything else imports them from here. |
| `gift-map.ts` | **The file you edit.** Which gift runs which commands, what each costs, price gates. |
| `gift-helpers.ts` | The small builders the map is written in (`at`, `banner`, `rep`, `ring`, `later`). |
| `gifts-CA.json` | A dated snapshot of one region's gift panel. Input to `--keys`. Refresh it with `--catalog`. |
| `catalog-scrape.js` | Browser-console snippet that produces a fresh `gifts-<REGION>.json`. |
| `fake-rcon.js` | A fake RCON server, for testing the bridge's reconnect behaviour with no Minecraft. |
| `docs/SETUP.md` | First-time setup, for someone who has never run a Minecraft server. |
| `docs/GOTCHAS.md` | The silent failures. Read this before writing your own gifts. |
| `examples/` | A hand-written sample recording, so `--replay` works before you have anything. |
| `tiktoklive-overlay/` | A stream overlay that tells viewers which gift does what. |
| `.env.example` | Template for `.env`, with notes on each variable. Copy it, fill it in. |

---

## Quickstart

### First, see it work with nothing set up

Before a Minecraft server, before a TikTok account, before anything:

```sh
git clone https://github.com/NabeelFK/tiktok-live-minecraft-bridge.git
cd tiktok-live-minecraft-bridge
npm ci
cp .env.example .env       # put any name in MC_PLAYER; --dry sends nothing anywhere
npm test                   # the offline test suite, about a second
npx tsx bridge.ts --replay examples/sample-gifts.jsonl --dry
```

That last command feeds a hand-written recording through the exact code path a real gift
takes and prints every Minecraft command it would send. It is the whole pipeline, minus
the two halves you have not set up yet. [examples/README.md](examples/README.md) explains
what each line of the sample is for, including the streak that is deliberately ignored,
the two gifts that share one name, and the malformed payloads.

It takes about fifteen seconds, because the last two gifts do not finish when their first
commands go out: one seals a pit 2.5 seconds later and the other is a nine-second staged
finale. The replay waits for them and prints what it is waiting for.

### Then the real thing

The rest assumes a Paper server with RCON enabled and a client joined to it. If you do
not have that yet, do [docs/SETUP.md](docs/SETUP.md) - it is the harder half.

Four variables, all documented in `.env.example`:

| Variable | What | Needed by |
|---|---|---|
| `MC_PLAYER` | Your exact in-game name, case sensitive | everything that sends commands |
| `TIKTOK_USER` | Your TikTok handle, no `@` | live mode |
| `RCON_PASSWORD` | The `rcon.password` from `server.properties` | everything that talks to the server |
| `EULER_API_KEY` | Euler Stream signing key. Optional, blank works | live mode, `--spy` |

The bridge loads `.env` from the repo root itself, on startup, in every mode. Filling
in that file is the whole configuration step: no flag to pass, and it is still there in
tomorrow's terminal window.

A variable set in your shell overrides the file, so a one-off is easy:
`$env:MC_PLAYER = "SomeoneElse"` in PowerShell, `export MC_PLAYER=SomeoneElse` in bash.

Then, in order:

```sh
npx tsx bridge.ts --keys      # is every gift in your map real, at the price you assumed?
npx tsx bridge.ts --verify    # does every command parse on your server? (server must be up)
npx tsx bridge.ts --test      # type gift names by hand and watch what happens
npx tsx bridge.ts             # live
```

npm scripts for the same things, plus the two checks that need nothing at all:

| Script | Runs |
|---|---|
| `npm test` | The offline test suite. No server, no network, under a second. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run keys` | `--keys` against the shipped catalog. |
| `npm run verify` | `--verify`. Needs the server. |
| `npm run sandbox` | `--test`, the interactive one where you type gift names. |
| `npm run live` | Live mode. |
| `npm run spy <handle>` | `--spy`. |
| `npm run replay <file>` | `--replay`. |

---

## Modes

| Command | Needs | What it does |
|---|---|---|
| `--test` | server | Reads gift names from stdin and runs them for real. `rose 5` fires a 5x streak, `mystery !1500` forces the 1500-coin fallback tier, `follow bob` tests the follower reward, `likes 250` pushes the like counter across its thresholds. This is how you watch an effect and judge whether it reads on camera. |
| `--spy <user>` | TikTok | Connects to anyone's live stream, prints raw gift, follow and like payloads, and records them to `spy-<user>-<timestamp>.jsonl` in the directory you ran it from. No Minecraft involved. Use it on a busy stream to collect real payloads. That file holds real viewers' display names and ids, so it is gitignored: keep it local. |
| `--replay <file.jsonl>` | server | Feeds a recorded `.jsonl` back through the exact handler live mode uses. This is how the live code path gets tested without being live. Pair with `--dry` and it needs no server, though it still needs `MC_PLAYER`, since the commands it builds name the player. |
| `--verify` | server | Syntax-checks every command in the map against your actual server version and runs none of them. Each command is wrapped in a selector that matches nothing, so the server parses it in full and then declines. Delayed stages are included. Exit code 1 on any failure. |
| `--keys [catalog.json]` | nothing | Checks the map against a region's gift catalog: keys no gift produces, two gifts colliding on one key, and prices that have drifted. Offline, no server, deterministic. Warns when the catalog is more than about a month old. Exit code 1 on any failure. |
| `--catalog [user]` | TikTok | Connects to a live room, reads the gift panel that room actually offers, and writes it over the catalog file `--keys` reads. Defaults to `TIKTOK_USER`, so pointed at your own stream it captures exactly what your viewers see. Prints what changed since the last capture: gifts added, gifts gone, prices moved. `--out <path>` and `--region <code>` override the destination and the stamped region. |
| *(no flag)* | both | Live mode. |

Flags that combine with any mode: `--dry` logs commands instead of sending them,
`--user <name>` overrides `TIKTOK_USER` for live mode. `--help` prints the same summary
as this table. An unrecognised flag is an error, not a silent fall-through to live mode.

### Pre-stream checklist

Run these, in this order, every time. They fail in different ways and none of them
substitutes for another.

0. **`--catalog`** - while your stream is live. Refreshes the gift catalog from the room's
   own panel, so the check below is against reality rather than against a file. Skip it
   and `--keys` is comparing your map to a photograph: gifts get retired and renamed with
   no notice, and a stale catalog does not fail, it agrees with you. Four mapped gifts in
   this repo were unreachable for three months exactly that way.
1. **`--keys`** - fast, offline, no server. Catches an effect that can never fire because
   no gift in your region produces that key. This failure is invisible at runtime: the
   gift just falls through to the coin-value fallback and does something plausible.
2. **`--verify`** - server must be up. Catches commands your Minecraft version rejects.
   Exit code 1 means do not stream yet.
3. **`--test`** - server up, client joined. Fire the gifts whose *behaviour* matters and
   watch them. A command can be valid, reachable, and still do nothing useful. Entity NBT
   in particular passes `--verify` and is silently ignored at runtime, which is exactly
   how this project shipped a launch gift that never launched anything.

`--keys` and `--verify` catch disjoint failures. `--verify` asks "is this valid
Minecraft?" and never notices an unreachable key. `--keys` asks "can this key ever fire?"
and never sends a command to a server.

---

## Customising the show

Everything you change lives in `gift-map.ts`. Three exports:

- `GIFTS` - normalized gift name to the commands it runs.
- `ASSUMED_COINS` - what you believe each gift costs. `--keys` checks it against the catalog.
- `PRICED` - for keys where two different gifts normalize to the same name and only the
  price tells them apart. In the Canadian catalog "Love you" (1 coin) and "Love You" (199)
  are both `loveyou`.

Keys are gift names lowercased with everything that is not a letter or a digit removed, so
"Finger Heart" is `fingerheart`. After any edit, run `--keys`, then `--verify`.

Read [docs/GOTCHAS.md](docs/GOTCHAS.md) before you write a gift. Most of the ways this
breaks are silent, and every entry in that file is a bug that actually shipped.

### Your region's catalog

`gifts-CA.json` is a snapshot of the **Canadian** catalog taken on June 23 2026. Gift
names and prices are region-specific, and TikTok changes them. If you are anywhere else,
it is the wrong catalog and `--keys` will be lying to you.

Get your own, in order of preference:

```sh
npx tsx bridge.ts --catalog        # while you are live: reads your room's own panel
```

That is the only source that is both your region and current, and it tells you what
changed since last time. If you are not live, `catalog-scrape.js` still works: open the
gift page for your region, paste it into the browser console, and it downloads
`gifts-<REGION>.json`, then `npx tsx bridge.ts --keys gifts-XX.json`. The header of that
file explains why it is a paste-into-the-console snippet and not an HTTP request.

Either way the file is dated the moment you make it. `--keys` warns when it is more than
about a month old.

---

## Free actions: follows and likes

Gifts cost money. Follows and likes do not, so both are handled in `bridge.ts` rather
than in the gift map.

| Action | Effect | Guard |
|---|---|---|
| Follow | One golden carrot | One per account per session. |
| Every 500 likes | One creeper, spawned at the player | One creeper per event, however many thresholds it crossed. |

**Neither is rate limited.** The follow guard is on identity, not on rate: the same
account cannot re-follow for repeat carrots, but a raid of 200 distinct accounts is 200
carrots, because each of those is a different person following for the first time. The
only backstop is the command queue's own backlog cap, which drops commands rather than
letting the show fall minutes behind.

For likes, the threshold IS the governor, which is why it is 500 and not 100. A busy room
satisfies 100 likes continuously, so at that number a creeper would land as often as
anything let it, and a creeper is the only effect in the map that permanently changes the
terrain. Blindness wears off and gear can be re-got; holes in the floor accumulate for the
whole stream. At 500 a milestone is an event that happens a few times an hour.

Likes need more care than follows in two other ways.

**Likes arrive in batches.** One event on the wire routinely carries ten or more likes,
so counting events counts nothing useful. The payload carries both the likes in that
event and the room's running total for the stream, and the bridge counts boundaries in
the running total. That is what makes it survive a reconnect: a locally summed counter
would reset, and a viewer who tapped ninety times would have to earn them again.

**One event can cross several thresholds.** A payload carrying 1,500 likes crosses three
five-hundred-marks at once. That fires **one** creeper, not three. Three creepers at the same
time is not three times the effect, it is a guaranteed death and a crater, in exchange
for an action nobody paid for. The console still prints how many boundaries went by.

Starting the bridge into a room that is already at 5,000 likes does not owe ten creepers:
the first event credits only the likes it carried and adopts the rest as the baseline.

To change the threshold, edit `LIKES_PER_CREEPER` in `bridge.ts`. It is the only place
the number is written down. To change what a milestone does, edit `likeCreeperCommands()`
next to it; `--verify` checks whatever is
in there along with every gift.

---

## The gift overlay

A viewer cannot send the right gift if they do not know what it does.
[`tiktoklive-overlay/gift-overlay.html`](tiktoklive-overlay/gift-overlay.html) is a
single self-contained page that rotates through the mapped gifts, showing each one's real
TikTok icon, the effect name, and a line on what happens. Help gifts are green, sabotage
red, and a verdict strip says which so the two cannot be confused at phone size.

The effect names on the cards are the same words the bridge prints in chat when a gift
lands, so a viewer reads `FLOOR GONE` on the overlay and then sees `FLOOR GONE` in chat a
second after they send it.

```sh
cd tiktoklive-overlay
npx serve .
```

Add it in LIVE Studio as **Add source -> Link**, pointing at
`http://127.0.0.1:3000/gift-overlay.html`. Use the `127.0.0.1` form: LIVE Studio has
rejected the `localhost` spelling of the same address. Include the filename, since `/`
serves a directory listing rather than the overlay. If that address is refused as well,
use your machine's LAN address on the same port, or host the file somewhere and point at
that. The background is transparent, so it composites over the game.

**Leave that terminal open for the whole stream.** It is the web server; close it and the
source goes blank.

**The gift list in that file is one streamer's, and is meant to be replaced.** Gift
availability and prices differ by region and TikTok retires gifts, so edit the `GIFTS`
array to match your own map and your own panel.
[tiktoklive-overlay/README.md](tiktoklive-overlay/README.md) explains every field and
where the icon URLs come from.

---

## Honest limitations

**This depends on an unofficial, reverse-engineered client.** TikTok publishes no API for
LIVE gift events. [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector)
works by speaking TikTok's internal webcast protocol. TikTok can change that protocol
whenever it likes, without warning and without any obligation to anyone. When it does,
this bridge stops receiving gifts until the library catches up, and payload field paths
(`data.gift.diamondCount` and friends) can move under you between library versions.

**It also depends on a third-party signing service.** The webcast handshake has to be
signed, and this project signs it through [Euler Stream](https://www.eulerstream.com/),
which is an independent commercial service with its own rate limits, pricing and uptime.
If Euler Stream is down, rate-limits you, or moves the free tier behind a paywall, live
mode stops working and there is nothing in this repo that can fix it.

Both of those can break with no notice, and if you are reading this a long time after it
was written, assume at least one of them has changed. Nothing here is TikTok-endorsed and
nothing here is guaranteed to keep working.

Smaller things worth knowing:

- Dependencies are pinned to exact versions on purpose. `tiktok-live-connector` has had
  breaking changes between releases and its npm version numbers do not line up with the
  API generations its documentation describes, so a `^` range is a live grenade. Upgrade
  deliberately, then re-run `--spy` and check the field paths still hold.
- Gift catalogs are per region and dated, and gifts get retired. Four of this map's 22
  gifts were retired out from under it in three months. `--catalog` is the fix, the coin
  tier fallback is the safety net, and `--keys` now warns when the file is old.
- RCON is a plaintext admin protocol with no rate limiting and no scoping. It is bound to
  `127.0.0.1` here. Do not port-forward it and do not put its password anywhere public.
- The bridge trusts what TikTok sends it. Display names are sanitized before they reach a
  command, but gift identity and coin values are whatever arrives on the wire.
- No moderation layer. Anyone who can send a gift can trigger an effect, including
  effects that end a run.

## TikTok LIVE eligibility

Most people hit this wall long before they hit any code. Access to LIVE is TikTok's to
grant, this project cannot change it, and the requirements move:

- **Age.** You must be 18 or older to go LIVE. Sending or receiving gifts is 18+ as well
  (19+ in South Korea). Gifts are the entire point of this project, so under 18 there is
  nothing here for you.
- **Followers.** TikTok gates LIVE access behind a follower threshold that it does not
  publish as a single global number. It is commonly 1,000 followers, and it varies by
  region and account.
- **Account standing.** LIVE access and gift eligibility can both be withdrawn for policy
  violations, and they are separate permissions: being able to go LIVE does not by itself
  mean you can receive gifts.
- **The stream itself must follow TikTok's rules.** Automated effects controlled by
  viewers do not exempt you from anything that happens on your stream.

Check the current requirements at the
[TikTok Help Center](https://support.tiktok.com/en/live-gifts-wallet/tiktok-live/what-is-tiktok-live)
rather than trusting this paragraph, or any blog post, on a topic TikTok changes quietly.

You can develop against all of this without being eligible: `--test` needs no TikTok
account at all, and `--spy` watches somebody else's live stream.

## License

MIT. See [LICENSE](LICENSE).
