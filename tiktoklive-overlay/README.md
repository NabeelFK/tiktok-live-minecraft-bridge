# Gift overlays

This folder contains two self-contained pages for TikTok LIVE Studio:

| File | Layout |
|---|---|
| `gift-overlay.html` | Two gifts per page, rotating every 4.5 seconds. |
| `gift-overlay-v2.html` | Two much larger gifts per page, detailed descriptions, rotating every 6 seconds. |
| `gift-overlay-v3.html` | Same two-card height as V2, full source width, and larger descriptions. |
| `gift-overlay-v4.html` | Full-width V3 cards reduced to 65% viewport height for a wide 2.74:1 overlay with a prominent page counter, rotating every 12 seconds. |
| `static-gift-overlay.html` | Every gift on one fixed screen with no rotation or scrolling. |
| `static-gift-overlay-v2.html` | Every gift in two large columns designed for a 9:16 portrait source. |

Both use the real TikTok icons and show a short explanation. The rotating overlay also
shows the effect title; the static overlay keeps only the gift name and description so
they can be larger. Green means the gift helps the run and red means it hurts.

The effect names are the same words the bridge prints in chat when a gift lands, so a
viewer who reads `FLOOR GONE` on the overlay sees `FLOOR GONE` in chat a second after
they send Balloons.

## Running it

```sh
cd tiktoklive-overlay
npx serve .
```

Then in LIVE Studio, choose **Add source -> Link** and paste either:

- `http://127.0.0.1:3000/gift-overlay.html` for the rotating overlay.
- `http://127.0.0.1:3000/gift-overlay-v2.html` for the larger, more descriptive rotating overlay.
- `http://127.0.0.1:3000/gift-overlay-v3.html` for the full-width V2 layout with larger descriptions.
- `http://127.0.0.1:3000/gift-overlay-v4.html` for the wide, thinner two-card layout.
- `http://127.0.0.1:3000/static-gift-overlay.html` for the all-at-once overlay.
- `http://127.0.0.1:3000/static-gift-overlay-v2.html` for the portrait all-at-once overlay.

For `static-gift-overlay-v2.html`, set the Link source resolution to **1080 x 1920** and
fit it to the portrait canvas. A landscape browser source squeezed into the top of a
portrait stream makes 22 descriptions unreadably small regardless of their CSS size.

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

Both page backgrounds are transparent, so they composite over the game. The rotating
overlay anchors at the bottom left. The static overlay is a centered board designed to
fit all listed gifts in a 16:9 browser source.

## Editing the gift list

**The lists in these files are one streamer's, for one region, and are meant to be
replaced.** Gift availability and prices differ by region, and TikTok retires gifts. Edit
the `GIFTS` array in the overlay being used. If both overlays are used, make the same
change in both arrays so they do not advertise different effects. Gifts left out of an
overlay still work; they are simply not advertised there.

Each entry in the `GIFTS` array:

| Field | What it is |
|---|---|
| `name` | The gift's exact name as it appears in the TikTok gift panel. |
| `coins` | Its price. It is kept so the arrays can be sorted by cost, but is not drawn on either overlay. |
| `icon` | URL of the gift's icon. A missing or broken one shows a `NO ICON` placeholder rather than an empty gap. |
| `effect` | The banner the bridge prints for that gift, e.g. `WEBBED`. Copy it exactly out of `gift-map.ts`, or the overlay and the chat will disagree. |
| `blurb` | One short line on what actually happens, in your voice. Viewers notice when it lies. |
| `kind` | `'harm'` or `'help'`. Drives the border, the effect colour, the verdict strip and the timer bar, so getting it wrong tells viewers the opposite of the truth. |

In `gift-overlay.html`, `ROTATE_MS` just above the array sets the dwell time per page.
The static overlay has no timer.

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
