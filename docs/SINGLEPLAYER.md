# Private single-player setup (Minecraft 26.2)

This is an additional way to run the bridge. It does not replace or alter the existing
Paper/RCON setup: leave off `--singleplayer` and every old command still uses RCON.

## One-time setup

1. Create or select a Minecraft 26.2 instance using Fabric Loader 0.19.3 or newer.
   This can be done with the Minecraft Launcher, Modrinth App, Prism Launcher, or any
   launcher that supports Fabric.
2. Install [Fabric API](https://modrinth.com/mod/fabric-api) in that instance. Install
   [Chunk Randomizer](https://modrinth.com/mod/chunk-randomizer) too if the stream uses
   that challenge; it is not required by the bridge itself.
3. Build the companion mod from this repository:

   Windows PowerShell:

   ```powershell
   cd singleplayer-mod
   .\gradlew.bat build
   cd ..
   ```

   macOS or Linux:

   ```sh
   cd singleplayer-mod
   ./gradlew build
   cd ..
   ```

4. Copy `singleplayer-mod/build/libs/tiktok-singleplayer-bridge-1.0.0.jar` into that
   Minecraft instance's `mods` folder.
5. Set `MC_PLAYER` and `TIKTOK_USER` in the repository's `.env`. The
   `RCON_PASSWORD` is not used in single-player mode.

Fabric mods are not selected from an in-game menu: every compatible jar in the active
instance's mods folder loads automatically. Some profiles created by the standalone Iris
installer override the normal `.minecraft/mods` directory with
`.minecraft/iris-reserved/<minecraft-version>`. Check the profile's game log or use a
standard Fabric profile if newly added jars do not appear in Fabric's startup mod list.

The companion mod listens only on `127.0.0.1:25576`. It does not publish the world to
LAN, port-forward anything, or accept another computer's connection.

## Test it before going live

Start Minecraft and enter the private world first. Then, from the repository root:

```powershell
npx tsx bridge.ts --test --singleplayer
```

Type `follow tester`, `likes 100`, or a gift name. The command should happen in the
world exactly as it does through RCON. Run the real stream with:

```powershell
npx tsx bridge.ts --singleplayer --provider piratetok
```

That uses the free, keyless PirateTok event source. Set `TIKTOK_PROVIDER=piratetok` in
`.env` to make `npx tsx bridge.ts --singleplayer` equivalent. The original Euler route
remains available with `--provider euler`.

The npm shortcuts are `npm run sandbox-singleplayer`,
`npm run live-singleplayer-free`, and `npm run live-singleplayer` (which uses the
provider from `.env`, or Euler when an older `.env` has no provider setting).

When Chunk Randomizer is installed, its challenge starts separately with `/rc start`.

Minecraft can pause its integrated server when the game loses focus or the pause menu
is open. Press `F3+P` until Minecraft says pause-on-lost-focus is disabled, and do not
leave the Escape pause menu open during the stream.

## Switching back to multiplayer

Nothing needs uninstalling. Start the Paper server and use the original commands:

```powershell
npx tsx bridge.ts --test
npx tsx bridge.ts
```

Those commands still use RCON on `127.0.0.1:25575` exactly as before.

The npm shortcuts for those commands are `npm run sandbox` and `npm run live`.
