# examples

## `sample-gifts.jsonl`

A hand-written recording in the format `--spy` produces, so `--replay` has something to
replay before you have a TikTok account, a Minecraft server, or a single real viewer.

```sh
npx tsx bridge.ts --replay examples/sample-gifts.jsonl --dry
```

`--dry` prints the commands instead of sending them, so nothing needs to be running. You
do need `MC_PLAYER` set, because every command names the player; any value works here.

**Every name and id in this file is invented.** Nothing came from a real recording, and
a real one should never be committed: `--spy` output contains real viewers' display
names and account ids, which is why `*.jsonl` is gitignored everywhere except this
folder.

### What each line is for

| Line | Payload | What it demonstrates |
|---|---|---|
| 1 | Rose, 1 coin | The ordinary case: one gift, one effect. |
| 2 | Rose, `repeatEnd: 0` | A mid-streak tick. **Ignored on purpose.** Acting on these turns one spammed rose into thirty triggers. |
| 3 | Rose, `repeatCount: 12` | The end of that streak. One trigger, twelve TNT. |
| 4 | Finger Heart, 5 coins | The next tier up. |
| 5 | "Love You", 199 coins | The gated body: GEAR GONE, 47 commands. |
| 6 | "Love you", 1 coin | The **same key**, different gift. Falls back to one TNT. This collision fired the 47-command strip on a 1-coin spam gift before `PRICED` existed. |
| 7 | "Mystery Crate", 500 coins | A gift that is not in the map at all: scaled by coin value instead. |
| 8 | Follow | One golden carrot. |
| 9 | The same follow again | Ignored. The same account cannot farm the reward. |
| 10 | `repeatCount: "twelve"` | A number field arriving as a string. This used to throw `RangeError: Invalid array length` and kill the process mid-stream. Now coerced. |
| 11 | No `gift.name` | What a library field-path change looks like. Prints a one-time warning instead of silently turning every gift into one TNT. |
| 12 | Hand Heart, 100 coins | BURIED, the cheap **delayed** case: the pit opens now, and the stone seal over your head is scheduled for 2.5 seconds later. |
| 13 | Sports Car, 7,000 coins | THE FINALE. Nine seconds, five stages, 40-odd commands scheduled after the first eight. |
| 14 | A truncated line | What `--spy` leaves behind when it is killed mid-write. Skipped with a warning, not fatal. |

Lines 10, 11 and 14 are the failure modes: a number arriving as a string, a field path
that has moved, and a half-written file. A run that handles all three is a bridge that
will not die in the middle of a stream.

Lines 12 and 13 are the ones that used to be impossible. A gift is not finished when its
first commands go out, and `--replay` used to stop as soon as the queue emptied, which is
before a stage scheduled seconds later could fire. Both gifts were dropped with nothing
printed. The replay now waits for what it started and says what it is waiting for:

```
[replay] waiting for 5 delayed stage(s), 48 command(s), last one 9.0s away
```

That is why the run takes about fifteen seconds, most of it the finale. It is finishing,
not hung. If something does have to be abandoned, it says so rather than going quiet.

### Watching a gift instead of reading it

`--replay --dry` prints commands. For the ones whose *behaviour* is the point, run them
against a real server and look at the screen: `npm run sandbox`, then type `handheart`
and watch the seal land, or `sportscar` and watch the nine seconds.
