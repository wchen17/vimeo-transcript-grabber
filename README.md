# vimeo-transcript-grabber

Pull the full transcript from any **Vimeo or YouTube** video you can watch, straight from your browser. No extension, no account, no server calls.

## The problem

Both sites show a transcript panel, but the obvious ways to get the text fail:

- **Vimeo — selecting and copying** only grabs what is on screen. The panel is a virtualized list: it keeps just a handful of lines in the page at a time and destroys the rest as you scroll, so a manual copy never gets the whole thing.
- **Vimeo — fetching the caption file** (`player.vimeo.com/.../texttrack/...vtt`) returns `error_code 8003` on private or restricted videos, because that URL is signed with a token only the video owner's session holds.
- **YouTube — finding the transcript at all.** Each redesign buries the "Show transcript" button deeper (now hidden inside the expanded description or the `...` menu), and once you find it the panel is still a scroll-and-skim affair, not a copyable block.

This script sidesteps all of that. The transcript is text the site already rendered into *your* page for *you* to read. The script just reads it out of the page — scrolling Vimeo's virtualized list to force the rest to render, and on YouTube even clicking "Show transcript" open for you. Nothing is fetched that you were not already shown.

## Usage

### Option A: console (one-time)

1. Open the video.
   - **Vimeo:** click the **Transcript / CC** panel so it is visible.
   - **YouTube:** nothing to do — the script tries to open the transcript itself. If it can't, expand the description (**...more**) and click **Show transcript** first.
2. Press **F12**, go to the **Console** tab.
3. Paste the contents of [`grab-transcript.js`](grab-transcript.js), press Enter.
4. A `.txt` named after the video downloads. On Vimeo the console logs `(complete 0-N)` when it captured every cue.

Stay on the tab while it runs. Background tabs throttle timers and the scroll stalls.

### Option B: bookmarklet (one click, reusable)

1. Create a new bookmark. Paste the single line from [`bookmarklet.txt`](bookmarklet.txt) as the URL.
2. On any Vimeo or YouTube video, click the bookmark (on Vimeo, open the Transcript panel first).

If the bookmark URL field strips the leading `javascript:`, type it back in by hand. Browsers do that as a paste-safety measure.

### Embedded videos

If the video is embedded on a non-Vimeo page, the player lives in an iframe. In the Console, switch the context dropdown (top-left, says "top") to the `player.vimeo.com` frame before running, so the script sees the transcript DOM.

## Output

Plain text, one cue per line, timestamps stripped. Feed it straight into an LLM, NotebookLM, or a summarizer.

---

## How it works (annotated, as a learning resource)

The whole thing is one async IIFE. Here is each section and the idea behind it.

### The wrapper: `(async () => { ... })();`

```js
(async () => { /* ... */ })();
```

This is an **IIFE** (immediately invoked function expression): define a function and call it on the same line. Two reasons it is shaped this way:

- `async` lets us use `await` inside, which we need because we have to pause for the page to render between scrolls. `await` is only legal inside an `async` function.
- Wrapping in a function keeps our variables (`scroller`, `cues`, etc.) out of the page's global scope, so we never collide with Vimeo's own code.

`const sleep = ms => new Promise(r => setTimeout(r, ms));` is the pause helper. `setTimeout` calls its callback after `ms` milliseconds; wrapping it in a Promise lets us write `await sleep(150)` to pause cleanly instead of nesting callbacks. *Why it works: `await` suspends the function until the Promise resolves, and ours resolves exactly when the timer fires.*

### 1. Find the scroll container

```js
const scroller = document.querySelector('[data-virtuoso-scroller="true"]')
  || document.querySelector('[data-test-id="virtuoso-scroller"]');
```

`document.querySelector` finds the first element matching a CSS selector. We target the attribute `data-virtuoso-scroller="true"` rather than a class like `css-7egl4`. *Why: Vimeo's CSS class names are hashes generated at build time and change on every deploy, but the structural `data-*` attributes are part of how the library works and stay stable.* The `||` is a fallback to an older attribute name. If neither exists, we bail with a message instead of throwing a confusing error.

### 2. The collector and the `Map`

```js
const cues = new Map();
const grab = () => document.querySelectorAll('div[data-index]').forEach(el =>
  cues.set(+el.getAttribute('data-index'), el.innerText.trim()));
```

`querySelectorAll` returns every currently-rendered cue. Each carries a `data-index` attribute (its position in the full transcript). We store each one in a **`Map`** keyed by that index.

The `Map` is the key design choice. The list is **virtualized**, meaning Vimeo reuses the same few `<div>` elements to display different cues as you scroll (this is what keeps a 10,000-line transcript fast). So the same DOM node is cue 5 at one moment and cue 60 later. Keying by `data-index` does two things at once: it **dedupes** (re-seeing cue 5 just overwrites the same key) and it lets us **reassemble the correct order** at the end regardless of the jumbled order we encountered them in.

`+el.getAttribute('data-index')` uses the unary `+` to convert the attribute string `"5"` into the number `5`, so the keys sort numerically later.

### 3. One scroll pass, waiting adaptively

```js
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
```

`scrollHeight` is the full scrollable height; `clientHeight` is one visible viewport. We step down one viewport at a time so no cue is skipped over without ever being rendered.

The inner loop is the speed trick. Instead of always pausing a fixed amount, it polls every 25ms and stops the instant `maxRendered()` (the highest cue index currently in the page) goes up, which means the new batch has painted. The `t < 400` is a safety cap so a stall cannot hang the loop forever. *Why this is faster than a fixed `sleep(200)`: on a quick render it proceeds after ~30ms; it only ever waits as long as the page actually needs.*

### 4. Repeat passes until stable

```js
let prev = -1, tries = 0;
while (cues.size !== prev && tries < 3) { prev = cues.size; await pass(); tries++; }
```

A single pass usually gets everything, but a slow render can drop a cue. So we run another full pass and stop only when the cue count stops growing (or after 3 passes). Sequential passes render every cue naturally. *Why this beats jumping straight to each missing cue: an earlier version scrolled proportionally to a missing index's estimated position, but cues have variable heights so the estimate is off, and on a long (900+ cue) transcript that fired hundreds of rapid jumps. The resulting scroll-and-re-render thrash can starve the video player and trigger Vimeo's "technical difficulty" overlay. Gentle repeated passes use far fewer scrolls and avoid that.*

### 5. Clean up and download

```js
const stripTime = s => s.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/\s+/g, ' ').trim();
const lines = [...cues.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => stripTime(t)).filter(Boolean);
```

`cues.entries()` gives `[index, text]` pairs; the spread `[...]` turns them into an array we can `sort` by index (`a[0] - b[0]` is the numeric-sort idiom). `.map` strips timestamps from each line and `.filter(Boolean)` drops any that became empty.

The regex `/\d{1,2}:\d{2}(:\d{2})?/g` matches a timestamp: one or two digits, a colon, two digits, and an optional `:ss` for hour-long videos. The `g` flag means replace every match in the line, not just the first.

```js
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
a.download = title + '.txt'; a.click();
```

This is the standard browser download trick with no server involved: wrap the text in a `Blob` (an in-memory file), make a temporary object URL pointing at it, attach that to an invisible `<a download>` link, and programmatically `.click()` it. The browser saves the Blob as a file. The filename comes from the page's `og:title` meta tag, with characters Windows forbids in filenames (`\ / : * ? " < > |`) stripped out.

### The one-line takeaway

Read what is already in the DOM, use a `Map` keyed by a stable index to defeat the recycling, and poll-don't-sleep so it is fast without dropping lines.

### YouTube: the easy cousin

YouTube needs none of the virtualization gymnastics. Its transcript panel renders **every** segment into the DOM at once, in document order, as `<ytd-transcript-segment-renderer>` elements:

```js
const segs = [...document.querySelectorAll('ytd-transcript-segment-renderer')];
const lines = segs
  .map(el => stripTime((el.querySelector('.segment-text, yt-formatted-string') || el).innerText))
  .filter(Boolean);
```

So there is no scrolling, no `Map`, no dedupe — just read each segment's `.segment-text` straight down the list. The shared `stripTime` and download helpers are reused as-is.

The only friction is that YouTube hides the panel. The script first checks whether segments already exist; if not, it expands the description and hunts for a button whose `aria-label` or text mentions "transcript", clicks it, and polls up to 5 seconds for the segments to appear:

```js
document.querySelector('tp-yt-paper-button#expand, #expand')?.click();
await sleep(300);
findBtn()?.click();
for (let t = 0; t < 5000 && !document.querySelector(segSel); t += 200) await sleep(200);
```

If the button has moved again in a future redesign, open the transcript by hand and rerun — the read step still works.

## Limitations

- Needs the transcript/captions to actually exist on the video. No captions, nothing to grab.
- Relies on each site's current DOM structure. If Vimeo or YouTube redesigns the transcript UI, the selectors may need updating. That is ordinary frontend churn, not something they can block, since the script only reads your own rendered page.
- YouTube's auto-open hunts for the "Show transcript" button by `aria-label`/text. If a redesign moves it, open the transcript manually and rerun.

## License

MIT. See [LICENSE](LICENSE).
