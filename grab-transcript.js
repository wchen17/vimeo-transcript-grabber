// vimeo-transcript-grabber (also works on YouTube)
// Pulls the full transcript from any Vimeo or YouTube video you can watch, straight from the browser console.
//
// Usage:
//   Vimeo   - open the video, click the Transcript (CC) panel so it is visible.
//   YouTube - open the video. The script tries to open the transcript itself;
//             if it can't, expand the description and click "Show transcript" first.
//   Then open DevTools (F12) -> Console, paste this whole file, press Enter.
// A .txt named after the video downloads. The console logs the cue count.

(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Shared helpers ---------------------------------------------------------
  // Strip leading/inline timestamps and collapse whitespace.
  const stripTime = s => s.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/\s+/g, ' ').trim();

  // Standard no-server download: wrap text in a Blob, click an invisible link.
  const download = lines => {
    const title = (document.querySelector('meta[property="og:title"]')?.content
      || document.title || 'transcript').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    a.download = title + '.txt'; a.click();
    return title;
  };

  // =======================================================================
  // YouTube
  // =======================================================================
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(location.hostname)) {
    const segSel = 'ytd-transcript-segment-renderer';

    // Try to open the transcript panel for the user. The "Show transcript"
    // button lives either in the expanded description or the ... menu, and
    // YouTube buries it harder every redesign, so we hunt a few selectors.
    if (!document.querySelector(segSel)) {
      const findBtn = () => [...document.querySelectorAll(
        'button, tp-yt-paper-button, ytd-button-renderer, ytd-menu-service-item-renderer, yt-button-shape button')]
        .find(b => /transcript/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
      // Expand the description first; the button is often hidden inside it.
      document.querySelector('tp-yt-paper-button#expand, #expand')?.click();
      await sleep(300);
      findBtn()?.click();
      for (let t = 0; t < 5000 && !document.querySelector(segSel); t += 200) await sleep(200);
    }

    const segs = [...document.querySelectorAll(segSel)];
    if (!segs.length) {
      console.log('Transcript not found. Expand the description, click "Show transcript", then rerun.');
      return;
    }

    // YouTube's transcript panel renders every segment in document order
    // (not virtualized like Vimeo), so a single read is enough.
    const lines = segs
      .map(el => stripTime((el.querySelector('.segment-text, yt-formatted-string') || el).innerText))
      .filter(Boolean);
    const title = download(lines);
    console.log(`Saved ${lines.length} cues as ${title}.txt`);
    return;
  }

  // =======================================================================
  // Vimeo
  // =======================================================================
  // 1. The real scroll container. Uses a stable attribute, not the hashed css-* class names.
  const scroller = document.querySelector('[data-virtuoso-scroller="true"]')
    || document.querySelector('[data-test-id="virtuoso-scroller"]');
  if (!scroller) { console.log("Transcript scroller not found. Open the Transcript panel, then rerun."); return; }

  // 2. Collect cues into a Map keyed by data-index (dedupes recycled nodes, preserves order).
  const cues = new Map();
  const grab = () => document.querySelectorAll('div[data-index]').forEach(el =>
    cues.set(+el.getAttribute('data-index'), el.innerText.trim()));
  const maxRendered = () => Math.max(-1, ...[...document.querySelectorAll('div[data-index]')]
    .map(el => +el.getAttribute('data-index')));

  // 3. One top-to-bottom pass, waiting only until each new batch paints.
  const pass = async () => {
    scroller.scrollTop = 0; await sleep(150); grab();
    for (let pos = 0; pos < scroller.scrollHeight; pos += scroller.clientHeight) {
      const before = maxRendered();
      scroller.scrollTop = pos + scroller.clientHeight;
      for (let t = 0; t < 400 && maxRendered() === before; t += 25) await sleep(25);
      grab();
    }
    scroller.scrollTop = scroller.scrollHeight; await sleep(200); grab();
  };

  // 4. Repeat whole passes until the cue count stops growing (max 3). Sequential
  // scrolling renders every cue and is far gentler than hundreds of random jumps,
  // which on long transcripts can thrash the page hard enough to crash the player.
  let prev = -1, tries = 0;
  while (cues.size !== prev && tries < 3) { prev = cues.size; await pass(); tries++; }

  // 5. Strip timestamps, assemble in order, download named after the video.
  const max = Math.max(...cues.keys());
  const lines = [...cues.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => stripTime(t)).filter(Boolean);
  const title = download(lines);

  const gaps = []; for (let i = 0; i <= max; i++) if (!cues.has(i)) gaps.push(i);
  console.log(`Saved ${lines.length} cues as ${title}.txt ` + (gaps.length ? `(missing ${gaps.length}: ${gaps.slice(0, 15)})` : `(complete 0-${max})`));
})();
