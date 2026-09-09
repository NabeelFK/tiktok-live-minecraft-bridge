# Setup, from nothing

Written for someone who has never run a Minecraft server. The code is the easy half of
this project; this page is the hard half. Budget an evening the first time.

You are going to end up with three things running at once:

- a **Paper server**, in its own terminal window, holding the world
- your **Minecraft client**, joined to that server as a normal player
- the **bridge**, in a second terminal, connecting TikTok to the server

They all run on the same machine and talk over `127.0.0.1`.

---

## 1. Java

A Minecraft server is a Java program, and it needs a specific Java version. Getting this
wrong is the single most common first failure, and the error message is usually a wall of
Java text rather than "wrong Java version".

Paper's own requirement, from [Paper's getting-started docs](https://docs.papermc.io/paper/getting-started):

| Minecraft version | Java version |
|---|---|
| 1.20 to 1.21.11 | Java 21 |
| 26.1 and newer | Java 25 |

Check the download page for the exact build you pick, because this table moves. Then get
that version from [Adoptium Temurin](https://adoptium.net/temurin/releases/) - free, open
source, and the build most server guides assume. Take the **JDK**, x64, Windows `.msi`,
and let the installer add Java to your `PATH`.

Verify in a fresh terminal:

```sh
java -version
```

If that prints an older version than the table wants, you have another Java installed and
earlier in your `PATH`. Fix the `PATH` rather than uninstalling things at random; several
programs ship their own Java and will not thank you.

## 2. The Paper server

**Paper** is a drop-in replacement for the vanilla Minecraft server. It behaves the same
and performs better. Any vanilla-compatible server works, but these instructions assume
Paper.

1. Make a folder for the server, somewhere outside this repo. Something like
   `Documents/mc-server`. It will fill up with world data, logs and config.
   Do not put it inside the repo folder - `.gitignore` guards against committing a server
   by accident, but the tidier answer is to keep them apart.
2. Download the server jar from [papermc.io/downloads/paper](https://papermc.io/downloads/paper).
   Pick a version, take the latest build, and drop the `.jar` into that folder.
3. Make a start script next to the jar. On Windows, `start.bat`:

   ```bat
   @echo off
   java -Xms4G -Xmx4G -jar paper.jar --nogui
   pause
   ```

   Rename `paper.jar` to whatever the file you downloaded is actually called. `-Xms4G
   -Xmx4G` gives the server 4 GB; 2 GB is enough for one player and a small world, and
   more than 8 GB helps nothing. `--nogui` keeps it in the terminal, which is what you
   want. `pause` keeps the window open when it crashes so you can read why.

   Paper publishes a [startup script generator](https://docs.papermc.io/misc/tools/start-script-gen)
   if you want tuned flags.

4. **First boot.** Double-click `start.bat`. It will run for a few seconds, complain, and
   exit:

   ```
   You need to agree to the EULA in order to run the server.
   ```

   That is expected. It has just written `eula.txt` next to the jar. Open it, change
   `eula=false` to `eula=true`, save. You are agreeing to
   [Minecraft's EULA](https://aka.ms/MinecraftEULA); read it if you like.

5. **Second boot.** Run `start.bat` again. It will take a minute to generate the world and
   then print `Done (…)! For help, type "help"`. That terminal is now the server console:
   you can type commands into it, and it is where server errors appear.

   Type `stop` to shut it down cleanly. Never close the window with the X while a world
   is loaded.

## 3. Turn on RCON

RCON is the remote console protocol. It is how the bridge sends commands to the server.
It is off by default.

Stop the server, then open `server.properties` in the server folder and set:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=pick-a-long-random-password-here
broadcast-rcon-to-ops=false
```

- `rcon.password` is a real credential. Make it long and random. It goes in your `.env`
  as `RCON_PASSWORD` and nowhere else. Never show `server.properties` on stream.
- `broadcast-rcon-to-ops=false` stops every command the bridge runs from being echoed into
  your chat, which would flood the screen during a gift storm.

While you are in there, worth setting for this kind of stream:

```properties
difficulty=normal
online-mode=true
max-players=2
```

> **Do not port-forward 25575.** RCON is plaintext, unauthenticated beyond that one
> password, and gives whoever reaches it full operator control of your server. It is
> bound to your own machine and it should stay that way. The bridge connects to
> `127.0.0.1`, on the same computer. Nothing about this project needs the port to be
> reachable from the internet, and neither does playing with friends over LAN.
> If you ever do expose a Minecraft server publicly, expose 25565 and never 25575.

Start the server again. The console should log an RCON listener on 25575.

## 4. Match your client to the server

Your Minecraft client must be the **same version** as the server. A 1.21.4 client cannot
join a 26.2 server, and the error it gives ("Outdated client" / "Outdated server") is at
least honest about it.

The server prints its version in the first lines of its console output, and it is in the
jar's filename.

In the Minecraft launcher: **Installations** -> **New installation** -> pick that exact
version -> Create -> Play.

## 5. Join your own server

With the server running and the client open:

**Multiplayer** -> **Direct Connection** -> Server Address: `localhost` -> Join Server.

`localhost` and `127.0.0.1` are the same thing here. No port needed unless you changed
`server-port` from 25565.

If it refuses: the server is not running yet, is still generating the world, or crashed.
The server terminal will say.

Once you are in, note your **exact in-game name, with its capitalisation**. That is
`MC_PLAYER`. Minecraft is case sensitive about it, and a wrong case means commands that
target nobody and fail quietly.

Give yourself operator rights from the server console so you can run commands in chat:

```
op YourExactName
```

## 6. Gamerules worth setting

Run these in-game (or from the server console, without the leading slash):

```
/gamerule sendCommandFeedback false
```

Without this, every command the bridge runs prints a confirmation into chat. During a
7,000-coin finale that is 55 commands in nine seconds and your chat becomes a wall of
grey text. The gift banners the bridge sends are `tellraw` messages and still show.

```
/gamerule keepInventory true
```

Strongly recommended. Several gifts are designed to kill, and without this each death
scatters everything on the ground and turns the stream into a ten-minute item recovery
instead of a run. The gifts that wipe your inventory still wipe it - that is deliberate
and different from dying.

Also useful:

```
/gamerule commandBlockOutput false
/gamerule logAdminCommands false
```

Both reduce console and chat noise.

## 7. Euler Stream, for the TikTok half

TikTok does not publish an API for LIVE gift events. The library this project uses
connects to TikTok's internal webcast websocket, and that connection requires a **signed**
handshake: a signature TikTok's own web player generates, which cannot be produced from
outside. [Euler Stream](https://www.eulerstream.com/) is a third-party service that
produces those signatures, and it is what makes live mode possible at all.

You do not strictly need an account. Signing works without a key at free community rate
limits, and the bridge warns you when it is running without one. A key raises the limits.

If you want one: sign up at [eulerstream.com](https://www.eulerstream.com/), take the
**Community** tier - free, 2,500 requests a day and 25 cloud websockets, which is far more
than one stream uses - and put the key in `.env` as `EULER_API_KEY`. Paid tiers exist for
people running many connections at once; a single streamer does not need them.

Prices and limits are Euler Stream's to change. Check
[their pricing page](https://www.eulerstream.com/pricing) rather than this paragraph.

## 8. Configuration: the `.env` file

The bridge reads four values and hardcodes none of them: `MC_PLAYER`, `TIKTOK_USER`,
`RCON_PASSWORD` and `EULER_API_KEY`. `.env.example` is the full list with a note on
each one.

### The normal way: create a `.env`

In the repo folder:

```powershell
cp .env.example .env
```

(`copy .env.example .env` in cmd.exe.) Open the copy, fill in the four values, save it.

That is the entire configuration step. The bridge loads that file itself on startup, in
every mode, so there is no flag to pass and nothing to remember. It also persists: a
`.env` is still there tomorrow, and in every new terminal window, which is the thing
shell variables are bad at.

`.env` is gitignored, and it must stay that way. Never commit it, never screenshot it,
never leave it open on stream. `RCON_PASSWORD` is a real credential for a server on
your machine, and `EULER_API_KEY` is a real API key.

Fill in what you have. `MC_PLAYER` and `RCON_PASSWORD` are the two that matter for
everything except `--keys`; `TIKTOK_USER` only matters when you go live, and
`EULER_API_KEY` can stay blank.

### The alternative: shell variables

Setting the variables directly still works, and it is what you want for a quick
override. PowerShell, for the current window only:

```powershell
$env:MC_PLAYER = "YourExactName"
$env:TIKTOK_USER = "yourhandle"
$env:RCON_PASSWORD = "the-password-from-server-properties"
```

These vanish when you close the window. `setx MC_PLAYER "YourExactName"` persists them,
but only for terminals you open *afterwards*, never the one you typed it in, which is a
reliable way to confuse yourself. The `.env` file avoids all of that.

### Which one wins

A variable set in your shell beats the same variable in `.env`. Nothing loaded from a
file can overwrite something you set deliberately, so:

```powershell
$env:MC_PLAYER = "SomeoneElse"
npx tsx bridge.ts --test
```

runs as a different player for that one session without touching the file. Unset it, or
close the window, and `.env` is back in charge.

### When something is missing

The bridge will not start a mode that needs a value it does not have. It names the
variable, and it tells you whether it found a `.env` at all:

```
fatal: MC_PLAYER is not set. It is your exact in-game name, case sensitive, and every command targets it.
No .env file was found. Copy .env.example to .env in the repo root and fill it in, or set the variable in your shell.
.env.example lists every variable this bridge reads; docs/SETUP.md walks through setting them.
```

If it says it read a `.env` and the variable is still missing, the line is blank or
misspelled in the file rather than absent from your terminal.

## 9. First run

Server up, client joined, `.env` filled in, in the repo folder:

```sh
npm ci
npx tsx bridge.ts --keys
```

That reads a saved gift catalog and needs neither the server nor the network. It should
end with `[keys] clean`.

If it reports dead keys, or warns that the catalog is stale, the catalog is probably
behind the real gift panel rather than the map being wrong. The file shipped here is
Canadian and dated, and TikTok retires gifts without notice. Fix it at the source, while
your stream is live:

```sh
npx tsx bridge.ts --catalog
```

That connects to your own room, reads the gift panel your viewers are actually looking
at, and writes it over the catalog file. Then run `--keys` again. **This is the
recommended way to keep the catalog current**, and the only one that reflects your
region as of today. `catalog-scrape.js` still works and needs no live stream, but it
reads a third-party website rather than the panel itself.

```sh
npx tsx bridge.ts --verify
```

This one needs the server up. It parses every command in the map against your actual
server version without running any of them, and it should end with something like
`172/172 passed`. Any FAIL line is a command your Minecraft version does not accept, and
it names the gift it came from.

```sh
npx tsx bridge.ts --test
```

Then type `rose` and watch. If TNT appears next to you, all three pieces are talking.

Try `handheart` to watch the buried effect, and `sportscar` for the finale. Watch
them, do not just read the console: a command can be valid and reachable and still do
nothing visible. See [GOTCHAS.md](GOTCHAS.md).

Finally:

```sh
npx tsx bridge.ts
```

Live mode. It connects to the handle in `TIKTOK_USER` and waits. If you are not live it
says so and retries every 30 seconds, which is harmless.

---

## When it does not work

**`Connection refused` on 127.0.0.1:25575** - the server is not running, or `enable-rcon`
is still `false`, or you edited `server.properties` without restarting the server.

**`fatal: RCON_PASSWORD is not set`** - the line is missing or blank in `.env`, or you
have no `.env` and are relying on shell variables in a different terminal from the one
you are running in. The second line of the error says which of those it is: it names the
`.env` files the bridge actually read, or says it found none.

**`Authentication failed`** - `RCON_PASSWORD` does not match `rcon.password` in
`server.properties`. Watch for a trailing space or smart quotes.

**Commands run, nothing happens in game** - almost always `MC_PLAYER` capitalisation, or
you are not actually on the server. Run `--verify`: it will pass, because the commands are
valid; then check the name.

**`Outdated client` / `Outdated server`** - client and server versions differ. Section 4.

**Gifts arrive but the wrong effect fires** - your region's catalog differs from the one
shipped here. Refresh it with `--catalog` while you are live, then run `--keys`.

**Live mode says the route is paid-tier only** - Euler Stream is refusing the request on
the free tier. This does not fix itself by retrying; the bridge stops rather than burning
your rate limit.

**Nothing arrives during a real stream** - confirm you are actually live and that gifts
are enabled on your account, then run `--spy <your-handle>` from another machine or after
the fact to see whether payloads are reaching the library at all.
