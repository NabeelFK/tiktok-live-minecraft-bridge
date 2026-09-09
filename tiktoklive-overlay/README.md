# Gift overlay

`gift-overlay.html` is a single self-contained page for TikTok LIVE Studio. It shows one
gift at a time - the real TikTok icon, the effect name, and one line on what happens -
and rotates every 4.5 seconds. Green means the gift helps the run, red means it hurts,
and a verdict strip spells it out so nobody has to work it out from the colour alone at
phone size.

The effect names are the same words the bridge prints in chat when a gift lands, so a
viewer who reads `FLOOR GONE` on the overlay sees `FLOOR GONE` in chat a second after
they send Balloons.

## Running it

```sh
cd tiktoklive-overlay
npx serve .
```

Then in LIVE Studio: **Add source -> Link**, and paste
`http://127.0.0.1:3000/gift-overlay.html`.

- Use **`127.0.0.1`**, not `localhost`. LIVE Studio has rejected the `localhost` form.
- Include the filename. `/` serves a directory listing, not the overlay. `serve` then
  redirects `/gift-overlay.html` to `/gift-overlay` and serves it from there, so a 301 in
  its log is normal and either URL works.
- Use the port `serve` prints. It is 3000 unless something already has it.
- If `127.0.0.1` is refused too, use your machine's LAN address on the same port
  (`http://192.168.x.x:3000/gift-overlay.html`; recent versions of `serve` print it as
  `On Your Network`), or host the file somewhere and use that URL.

**Leave that terminal open for the whole stream.** It is the web server. Close it and the
source goes blank.

The background is transparent, so the card composites straight over the game. It anchors
bottom left; change `align-items` / `justify-content` on `body` in the CSS to move it.

## Editing the gift list

**The list in the file is one streamer's, for one region, and is meant to be replaced.**
Gift availability and prices differ by region, and TikTok retires gifts, so treat these
ten as a worked example rather than a starting point you can ship as-is. Keep the list to
about ten: past that nobody reads it. Gifts you leave out still work, they are just not
advertised.

Each entry in the `GIFTS` array:

| Field | What it is |
|---|---|
| `name` | The gift's exact name as it appears in the TikTok gift panel. |
| `coins` | Its price. **Not drawn on the card.** It is kept so the array can be sorted by cost and so prices are easy to show later. |
| `icon` | URL of the gift's icon. A missing or broken one shows a `NO ICON` placeholder rather than an empty gap. |
| `effect` | The banner the bridge prints for that gift, e.g. `WEBBED`. Copy it exactly out of `gift-map.ts`, or the overlay and the chat will disagree. |
| `blurb` | One short line on what actually happens, in your voice. Viewers notice when it lies. |
| `kind` | `'harm'` or `'help'`. Drives the border, the effect colour, the verdict strip and the timer bar, so getting it wrong tells viewers the opposite of the truth. |

`ROTATE_MS` just above the array sets the dwell time per card.

Harm and help entries are interleaved at render time, so the rotation alternates instead
of running seven punishments before the first reward.

## Where the icon URLs come from

They are TikTok's own CDN URLs for each gift image. TikTok returns them in the gift
payload at `gift.image.urlList`, and in the same `gift/list` response that
`npx tsx bridge.ts --catalog` reads. The quickest way to collect your own set is to run
`--spy` against a live room and read the URLs out of the recorded payloads, or to extend
`--catalog` to keep the icon URL alongside the name and price.

They are hotlinked, not stored here: the page fetches them from TikTok at display time,
so the overlay needs a working internet connection to draw icons. The two fonts load from
Google Fonts for the same reason, and fall back to system faces if they cannot.
