// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Recording through Playwright's page.screencast (Playwright 1.64+): start and stop at any
// point, page load excluded unless you want it. The browser sends a frame each time the page
// repaints; Playwright encodes them to WebM (VP8) at a fixed frame rate, or hands them to you.
// Works for browsers and for Electron apps (VS Code). Caveats: see SKILL.md.

// A moving pointer only: Playwright's default title names the call ("Click locator('#cta')"), which
// belongs in a debugging recording, not a demo. Pass `actions: { style: {} }` to bring it back.
const DEMO_ACTIONS = { cursor: "pointer", style: { title: "display: none" } };

/**
 * Records the page into a WebM from now until `stop()`. With `actions` (default), Playwright
 * draws a pointer that moves from one action to the next. Annotations from annotate() show up
 * as drawn on the page.
 * @param {import("playwright").Page} page
 * @param {string} file output path (.webm)
 * @param {{ size?: { width: number, height: number }, fps?: number, actions?: boolean | object }} [options]
 *   `actions`: false, or options for page.screencast.showActions (cursor, duration, position, style)
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */

export async function startRecording(page, file, { size, fps, actions = true } = {}) {
  await startScreencast(page, { path: file, size, fps });
  const decorations = await showDecorations(page, actions);
  return {
    async stop() {
      await decorations?.dispose();
      await page.screencast.stop();
    },
  };
}

/**
 * Collects the page's frames from now until `stop()`, as GIF frames for encodeGif: each frame is
 * held until the next one arrived. Frames closer together than `everyMs` are merged into the newest
 * of them, which keeps a GIF of a busy page small.
 * @param {import("playwright").Page} page
 * @param {{ size?: { width: number, height: number }, quality?: number, everyMs?: number, actions?: boolean | object }} [options]
 * @returns {Promise<{ stop: (options?: { lastHoldMs?: number }) => Promise<Array<{ png: Buffer, holdMs: number }>> }>}
 *   `png` holds JPEG bytes here; encodeGif accepts both.
 */
export async function startFrameCapture(page, { size, quality = 90, everyMs = 100, actions = true } = {}) {
  const frames = [];
  await startScreencast(page, {
    size, quality,
    onFrame: ({ data, timestamp }) => { frames.push({ data: Buffer.from(data), ms: timestamp }); }, // epoch ms
  });
  const decorations = await showDecorations(page, actions);
  return {
    async stop({ lastHoldMs = 1500 } = {}) {
      await decorations?.dispose();
      await page.screencast.stop();
      const kept = [];
      for (const f of frames) {
        // Within a burst keep the newest image (the state the page settled on), at the burst's start time.
        if (kept.length && f.ms - kept.at(-1).ms < everyMs) { kept[kept.length - 1] = { data: f.data, ms: kept.at(-1).ms }; continue; }
        kept.push(f);
      }
      return kept.map((f, i) => ({ png: f.data, holdMs: i + 1 < kept.length ? Math.round(kept[i + 1].ms - f.ms) : lastHoldMs }));
    },
  };
}

/**
 * Starts the screencast and returns once its first frame arrived. Headless Chromium sends the
 * first frame only ~2 s after start, so whatever happens before that is missing from the
 * recording. Waiting makes the clip start with the page as it is when start() returns.
 */
async function startScreencast(page, { onFrame, ...options }, timeoutMs = 10000) {
  let firstFrame;
  const arrived = new Promise(resolve => { firstFrame = resolve; });
  await page.screencast.start({
    ...options,
    onFrame: frame => { firstFrame(); return onFrame?.(frame); },
  });
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no screencast frame within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([arrived, timedOut]);
  } catch (err) {
    await page.screencast.stop().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function showDecorations(page, actions) {
  if (!actions) { return undefined; }
  return page.screencast.showActions({ ...DEMO_ACTIONS, ...(typeof actions === "object" ? actions : {}) });
}

/**
 * Stills from a WebM at the given times (seconds), by playing it in the canvas page. Look at
 * these before publishing a recording, as with a GIF's frames: you can't watch a video here.
 * @param {import("playwright").Page} canvasPage from openCanvasPage (annotate.mjs)
 * @param {Buffer} webm
 * @param {number[]} seconds
 * @returns {Promise<{ duration: number, stills: Buffer[] }>} PNG stills
 */
export async function videoStills(canvasPage, webm, seconds) {
  const { duration, shots } = await canvasPage.evaluate(async ({ src, seconds }) => {
    const v = document.createElement("video");
    v.muted = true;
    v.src = src;
    await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = () => reject(new Error("not a playable video")); });
    // A screencast WebM has no duration in its header until seeked past the end.
    if (!Number.isFinite(v.duration)) { v.currentTime = 1e9; await new Promise(r => { v.onseeked = r; }); }
    const shots = [];
    for (const t of seconds) {
      v.currentTime = Math.min(t, v.duration);
      await new Promise(r => { v.onseeked = r; });
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      shots.push(c.toDataURL("image/png").split(",")[1]);
    }
    return { duration: v.duration, shots };
  }, { src: `data:video/webm;base64,${webm.toString("base64")}`, seconds });
  return { duration, stills: shots.map(s => Buffer.from(s, "base64")) };
}

/**
 * Whole-session recording from page creation (popups included), through the context option.
 * The file is finished only when the context or app closes: save it with saveRecording.
 * @param {string} dir where Playwright writes the raw recording
 * @param {{ width: number, height: number }} size
 */
export function recordingOptions(dir, size) {
  return { recordVideo: { dir, size } };
}

/**
 * Closes whatever owns a recordingOptions recording and saves it.
 * @param {() => Promise<void>} close closes the context or the Electron app
 */
export async function saveRecording(page, file, close) {
  const video = page.video();
  if (!video) { throw new Error("this page is not being recorded: pass recordingOptions() when creating it"); }
  await close();
  await video.saveAs(file);
  await video.delete();
}
