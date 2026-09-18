# TikTok Singleplayer Bridge mod

This Fabric 26.2 client mod lets the repository's existing bridge execute its Minecraft
commands inside a private single-player world. It listens only on `127.0.0.1:25576`; it
does not open the world to LAN or accept connections from another computer.

Build it on Windows with `gradlew.bat build`, or on macOS/Linux with `./gradlew build`.
The jar is written to `build/libs` and belongs in a Minecraft 26.2 Fabric instance's
`mods` folder alongside Fabric API. Chunk Randomizer is optional and is not a dependency
of this mod.

Start Minecraft, enter a world, and run `npx tsx bridge.ts --singleplayer` from the
repository root. Leave that flag off to use the original Paper/RCON path unchanged.
