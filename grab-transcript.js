// vimeo-transcript-grabber
// Pulls the full transcript from any Vimeo video you can watch, straight from the browser console.
//
// Usage: open the video, click the Transcript (CC) panel so it is visible,
// open DevTools (F12) -> Console, paste this whole file, press Enter.
// A .txt named after the video downloads. The console logs the cue count.

(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  // 3. Walk down one viewport at a time, waiting only until new cues paint.
  scroller.scrollTop = 0; await sleep(150); grab();
  for (let pos = 0; pos < scroller.scrollHeight; pos += scroller.clientHeight) {
    const before = maxRendered();
    scroller.scrollTop = pos + scroller.clientHeight;
    for (let t = 0; t < 300 && maxRendered() === before; t += 25) await sleep(25);
    grab();
  }
  scroller.scrollTop = scroller.scrollHeight; await sleep(150); grab();

  // 4. Fill any gaps so going fast never costs completeness.
  const max = Math.max(...cues.keys());
  for (let i = 0; i <= max; i++) if (!cues.has(i)) {
    scroller.scrollTop = (i / max) * scroller.scrollHeight;
    await sleep(120); grab();
  }

  // 5. Strip timestamps, assemble in order, download named after the video.
  const stripTime = s => s.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/\s+/g, ' ').trim();
  const lines = [...cues.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => stripTime(t)).filter(Boolean);
  const title = (document.querySelector('meta[property="og:title"]')?.content
    || document.title || 'transcript').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  a.download = title + '.txt'; a.click();

  const gaps = []; for (let i = 0; i <= max; i++) if (!cues.has(i)) gaps.push(i);
  console.log(`Saved ${lines.length} cues as ${title}.txt ` + (gaps.length ? `(MISSING ${gaps.length})` : `(complete 0-${max})`));
})();
