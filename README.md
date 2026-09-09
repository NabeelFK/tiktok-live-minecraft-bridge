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
| `env.ts` | Loads `.env` and resolves the four configuration values. Everything else imports them from here. |
| `gift-map.ts` | **The file you edit.** Which gift runs which commands, what each costs, price gates. |
| `gift-helpers.ts` | The small builders the map is written in (`at`, `banner`, `rep`, `ring`, `later`). |
| `gifts-CA.json` | A dated snapshot of one region's gift catalog. Input to `--keys`. Regenerate your own. |
| `catalog-scrape.js` | Browser-console snippet that produces a fresh `gifts-<REGION>.json`. |
| `fake-rcon.js` | A fake RCON server, for testing the bridge's reconnect behaviour with no Minecraft. |
| `docs/SETUP.md` | First-time setup, for someone who has never run a Minecraft server. |
| `docs/GOTCHAS.md` | The silent failures. Read this before writing your own gifts. |
| `.env.example` | Template for `.env`, with notes on each variable. Copy it, fill it in. |

---

## Quickstart

Assumes a Paper server with RCON enabled and a client joined to it. If you do not have
that yet, do [docs/SETUP.md](docs/SETUP.md) first - it is the harder half.

```sh
git clone https://github.com/NabeelFK/tiktok-live-minecraft-bridge.git
cd tiktok-live-minecraft-bridge
npm ci
cp .env.example .env      # then fill it in
```

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

There are npm scripts for the same things: `npm run keys`, `npm run verify`, `npm test`,
`npm run live`, and `npm run spy <handle>` / `npm run replay <file.jsonl>` for the two
that take an argument.

---

## Modes

| Command | Needs | What it does |
|---|---|---|
| `--test` | server | Reads gift names from stdin and runs them for real. `rose 5` fires a 5x streak, `mystery !1500` forces the 1500-coin fallback tier, `follow bob` tests the follower reward. This is how you watch an effect and judge whether it reads on camera. |
| `--spy <user>` | TikTok | Connects to anyone's live stream, prints raw gift and follow payloads, and records them to `spy-<user>-<timestamp>.jsonl` in the directory you ran it from. No Minecraft involved. Use it on a busy stream to collect real payloads. That file holds real viewers' display names and ids, so it is gitignored: keep it local. |
| `--replay <file.jsonl>` | server | Feeds a recorded `.jsonl` back through the exact handler live mode uses. This is how the live code path gets tested without being live. Pair with `--dry` and it needs no server, though it still needs `MC_PLAYER`, since the commands it builds name the player. |
| `--verify` | server | Syntax-checks every command in the map against your actual server version and runs none of them. Each command is wrapped in a selector that matches nothing, so the server parses it in full and then declines. Delayed stages are included. Exit code 1 on any failure. |
| `--keys [catalog.json]` | nothing | Checks the map against a region's gift catalog: keys no gift produces, two gifts colliding on one key, and prices that have drifted. Offline, no server, deterministic. Exit code 1 on any failure. |
| *(no flag)* | both | Live mode. |

Flags that combine with any mode: `--dry` logs commands instead of sending them,
`--user <name>` overrides `TIKTOK_USER` for live mode. `--help` prints the same summary
as this table. An unrecognised flag is an error, not a silent fall-through to live mode.

### Pre-stream checklist

Run these three, in this order, every time. They fail in different ways and none of them
substitutes for another.

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

Generate your own: open the gift page for your region, paste `catalog-scrape.js` into the
browser console, and it downloads `gifts-<REGION>.json`. Then
`npx tsx bridge.ts --keys gifts-XX.json`. The header of `catalog-scrape.js` explains why
this is a paste-into-the-console snippet and not an HTTP request.

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
- Gift catalogs are per region and dated. See above.
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
