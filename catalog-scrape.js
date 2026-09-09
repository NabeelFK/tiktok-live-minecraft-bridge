/**
 * catalog-scrape.js - regenerate gifts-<REGION>.json, the input for `npx tsx bridge.ts --keys`.
 *
 * WHY THIS IS A COPY-PASTE SNIPPET AND NOT AN HTTP FETCH
 * -----------------------------------------------------
 * The gift page cannot be scraped from a script:
 *   - Plain HTTP clients (curl, fetch) get a 403. The page is not served to them.
 *   - Page-summarising tools that DO return something truncate it around 499 coins and
 *     then answer "not found" for every gift above that. Doing this once reported Money
 *     Gun, Swan, Train, Galaxy and Red Devil Corgi as absent from the Canadian catalog.
 *     All five are present. A confident wrong answer is worse than an error, and this
 *     one is silent: the map keys for those gifts look dead when they are fine.
 * What works is a real browser that has already rendered the page. The whole catalog is
 * in the DOM at once (~11k chars of innerText, 553 gifts for CA), so no scrolling or
 * pagination is needed.
 *
 * HOW TO USE
 * ----------
 * 1. Open https://streamtoearn.io/gifts?region=CA  (swap the region code as needed)
 * 2. Open DevTools -> Console
 * 3. Paste EVERYTHING below the marker line and press Enter
 * 4. A file named gifts-CA.json downloads. Move it next to bridge.ts
 * 5. npx tsx bridge.ts --keys
 *
 * Sanity check before trusting a fresh dump: it should cover the full coin range, from
 * 1 up into the tens of thousands. The Canadian catalog was 553 gifts, 1 to 44999 coins,
 * on June 23 2026. A dump that stops around 499 is a truncated read - throw it away, do
 * not run --keys against it. This snippet throws if it parses fewer than 100 gifts.
 *
 * ----------------------------- PASTE FROM HERE -----------------------------
 */
(() => {
  const region = (new URLSearchParams(location.search).get('region') || 'XX').toUpperCase();
  const t = document.body.innerText;

  const start = t.indexOf('Last update');
  if (start < 0) throw new Error('could not find the "Last update" marker - page layout changed');
  const end = t.indexOf('FILTER BY COST', start);
  if (end < 0) throw new Error('could not find the "FILTER BY COST" marker - page layout changed');

  const catalogUpdated = (t.slice(start, start + 80).match(/Last update:\s*([^\n]+)/) || [])[1] || 'unknown';

  // The grid renders as alternating lines: a gift name, then its coin value.
  const parts = t.slice(t.indexOf('\n', start), end).split('\n').map((s) => s.trim()).filter(Boolean);
  const gifts = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^\d+$/.test(parts[i + 1]) && !/^\d+$/.test(parts[i])) {
      gifts.push({ name: parts[i], coins: parseInt(parts[i + 1], 10) });
      i++;
    }
  }
  if (gifts.length < 100) throw new Error(`only parsed ${gifts.length} gifts - that is a truncated read, do not use it`);

  const doc = {
    region,
    source: location.href,
    catalogUpdated,
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedBy: 'catalog-scrape.js in a browser console',
    drifts: 'Gift names and prices are region-specific and change over time. This file is a dated snapshot; re-run this snippet before any stream where balance matters.',
    doNotFetch: 'Do not regenerate this with an HTTP fetch or a page-summarising tool. They truncate the page around 499 coins and report everything above as absent. See the header of catalog-scrape.js.',
    giftCount: gifts.length,
    gifts,
  };

  const blob = new Blob([JSON.stringify(doc, null, 1) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gifts-${region}.json`;
  a.click();
  URL.revokeObjectURL(a.href);

  console.log(`gifts-${region}.json: ${gifts.length} gifts, ${Math.min(...gifts.map(g => g.coins))} to ${Math.max(...gifts.map(g => g.coins))} coins, catalog dated ${catalogUpdated}`);
  return doc;
})();
