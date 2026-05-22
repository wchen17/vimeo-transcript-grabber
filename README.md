# vimeo-transcript-grabber

Pull the full transcript from any Vimeo video you can watch, straight from your browser. No extension, no account, no server calls.

## The problem

Vimeo shows a transcript panel, but two obvious ways to get the text both fail:

- **Selecting and copying** only grabs what is on screen. The panel is a virtualized list: it keeps just a handful of lines in the page at a time and destroys the rest as you scroll, so a manual copy never gets the whole thing.
- **Fetching the caption file** (`player.vimeo.com/.../texttrack/...vtt`) returns `error_code 8003` on private or restricted videos, because that URL is signed with a token only the video owner's session holds.

This script sidesteps both. The transcript is text Vimeo already rendered into *your* page for *you* to read. The script just reads it out of the page and scrolls the list to force the rest to render. Nothing is fetched that you were not already shown.

## Usage

### Option A: console (one-time)

1. Open the Vimeo video. Click the **Transcript / CC** panel so it is visible.
2. Press **F12**, go to the **Console** tab.
3. Paste the contents of [`grab-transcript.js`](grab-transcript.js), press Enter.
4. A `.txt` named after the video downloads. The console logs `(complete 0-N)` when it captured every cue.

Stay on the tab while it runs. Background tabs throttle timers and the scroll stalls.

### Option B: bookmarklet (one click, reusable)

1. Create a new bookmark. Paste the single line from [`bookmarklet.txt`](bookmarklet.txt) as the URL.
2. On any Vimeo video, open the Transcript panel, then click the bookmark.

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

## Limitations

- Needs the transcript panel to actually exist on the video. No captions, nothing to grab.
- Relies on Vimeo's current DOM structure. If they redesign the transcript UI, the selectors in step 1 and 2 may need updating. That is ordinary frontend churn, not something Vimeo can block, since the script only reads your own rendered page.

## License

MIT. See [LICENSE](LICENSE).
