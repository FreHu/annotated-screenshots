import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { annotate, annotateScreenshot, clearAnnotations, measureAll, openCanvasPage, pngSize } from "../skills/annotated-screenshots/lib/annotate.mjs";
import { DEFAULT_STYLE } from "../skills/annotated-screenshots/lib/draw.mjs";
import { encodeGif, verifyGif } from "../skills/annotated-screenshots/lib/gif.mjs";
import { resolveEditorTarget } from "../skills/annotated-screenshots/lib/vscode-targets.mjs";
import { recordingOptions, saveRecording, startFrameCapture, startRecording, videoStills } from "../skills/annotated-screenshots/lib/video.mjs";

const site = pathToFileURL(fileURLToPath(new URL("../examples/fixture-site/index.html", import.meta.url))).href;
const viewport = { width: 1100, height: 700 };
const accent = [0xff, 0xb0, 0x2e];
let browser;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

/** RGB of one pixel of a PNG. */
async function pixel(canvas, png, x, y) {
  return canvas.evaluate(async ({ src, x, y }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
  }, { src: `data:image/png;base64,${png.toString("base64")}`, x, y });
}
const near = (rgb, want, tolerance = 24) => rgb.every((v, i) => Math.abs(v - want[i]) <= tolerance);

/**
 * Every colour in a PNG or JPEG within a rectangle (CSS px, times `scale` image px), with its pixel
 * count. Counts each pixel the rectangle touches, edges included. No rectangle: the whole image.
 * @returns {Promise<Map<string, number>>} "r,g,b" → pixels
 */
async function colours(canvas, image, rect, scale = 1) {
  const area = rect && {
    x: Math.floor(rect.x * scale), y: Math.floor(rect.y * scale),
    right: Math.ceil((rect.x + rect.width) * scale), bottom: Math.ceil((rect.y + rect.height) * scale),
  };
  return new Map(await canvas.evaluate(async ({ src, area }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const a = area ?? { x: 0, y: 0, right: c.width, bottom: c.height };
    const data = ctx.getImageData(a.x, a.y, a.right - a.x, a.bottom - a.y).data;
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts];
  }, { src: `data:image/png;base64,${image.toString("base64")}`, area }));
}
const rgb = key => key.split(",").map(Number);
const black = [0, 0, 0];
const ctaRed = [0xe2, 0x55, 0x3f]; // the fixture's button: nothing else on the page is this colour

async function sitePage(options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  await page.goto(site);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, canvas: await openCanvasPage(await browser.newContext()) };
}

test("annotateScreenshot leaves the source PNG untouched and keeps its size", async () => {
  const { context, page, canvas } = await sitePage();
  const measured = await measureAll(page, [{ target: { locator: page.locator("#cta") }, text: "CTA", labelX: 520 }]);
  const png = await page.screenshot();
  const before = Buffer.from(png);
  const out = await annotateScreenshot(canvas, png, measured);
  assert.equal(Buffer.compare(png, before), 0, "source buffer unchanged");
  assert.deepEqual(pngSize(out), pngSize(png));
  assert.notEqual(Buffer.compare(out, png), 0, "something was drawn");
  await context.close(); await canvas.context().close();
});

test("annotateScreenshot takes a JPEG and returns a PNG of the same size", async () => {
  const { context, page, canvas } = await sitePage();
  const measured = await measureAll(page, [{ target: { locator: page.locator(".plan").nth(1) }, marker: 2 }]);
  const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
  const out = await annotateScreenshot(canvas, jpeg, measured);
  assert.deepEqual(pngSize(out), viewport);
  const [m] = measured;
  assert.ok(near(await pixel(canvas, out, m.rect.x + 8, m.rect.y + m.rect.height / 2), accent), "marker drawn");
  await context.close(); await canvas.context().close();
});

test("full-page: a callout below the fold lands on its target", async () => {
  const { context, page, canvas } = await sitePage();
  await page.evaluate(() => scrollTo(0, 400)); // boxes are viewport-relative: fullPage must add the scroll offset
  const [refund] = await measureAll(page, [{ target: { locator: page.locator("#refund") }, text: "Refund", above: 40 }], { fullPage: true });
  // Ground truth from the document, not from the library's own measurement.
  const doc = await page.locator("#refund").evaluate(el => {
    const r = el.getBoundingClientRect();
    return { cx: r.left + scrollX + r.width / 2, top: r.top + scrollY };
  });
  assert.ok(doc.top > viewport.height, "target is below the fold");
  const out = await annotateScreenshot(canvas, await page.screenshot({ fullPage: true }), [refund]);
  // The callout's dot sits at the target's top edge, centred.
  assert.ok(near(await pixel(canvas, out, doc.cx, doc.top), accent), "dot drawn at the target's document position");
  await context.close(); await canvas.context().close();
});

test("deviceScaleFactor 2: annotations scale with the image", async () => {
  const { context, page, canvas } = await sitePage({ deviceScaleFactor: 2 });
  const [m] = await measureAll(page, [{ target: { locator: page.locator(".plan").nth(1) }, marker: 2 }]);
  const png = await page.screenshot();
  assert.equal(pngSize(png).width, viewport.width * 2);
  const out = await annotateScreenshot(canvas, png, [m], { scale: 2 });
  // A marker is a 22 px circle centred on (rect.x, middle of rect), its digit in the middle:
  // sample 8 CSS px right of centre, inside the circle but clear of the digit.
  const cy = (m.rect.y + m.rect.height / 2) * 2;
  assert.ok(near(await pixel(canvas, out, (m.rect.x + 8) * 2, cy), accent), "marker drawn at 2× its CSS position");
  assert.ok(!near(await pixel(canvas, out, (m.rect.x + 8) * 1, cy / 2), accent), "not at the unscaled position");
  await context.close(); await canvas.context().close();
});

test("overlay: the page's CSS reset doesn't restyle labels, and clearAnnotations removes them", async () => {
  const { context, page, canvas } = await sitePage();
  await annotate(page, [{ target: { locator: page.locator("#cta") }, text: "CTA", labelX: 520 }]);
  const style = await page.evaluate(() => {
    const label = [...document.querySelectorAll("#annotated-screenshots-overlay div")].find(d => d.textContent === "CTA");
    const s = getComputedStyle(label);
    return { size: s.fontSize, weight: s.fontWeight, display: s.display };
  });
  // The fixture sets `* { font: inherit }` (16px Georgia) and `div { display: grid }`.
  assert.deepEqual(style, { size: "13px", weight: "600", display: "block" });
  await clearAnnotations(page);
  assert.equal(await page.locator("#annotated-screenshots-overlay").count(), 0);
  await context.close(); await canvas.context().close();
});

test("GIF: held frames decode back to their stills, crossfades included", async () => {
  const { context, page, canvas } = await sitePage();
  const frames = [{ png: await page.screenshot(), holdMs: 500, fadeMs: 200 }];
  await page.click("#cta");
  frames.push({ png: await page.screenshot(), holdMs: 500 });
  const gif = await encodeGif(canvas, frames);
  const check = await verifyGif(canvas, gif, frames);
  assert.equal(check.frameCount, 1 + 4 + 1, "one held frame, 4 fade steps (200 ms / 40), one held frame");
  for (const e of check.keyFrameErrors) { assert.ok(e < 1, `held frame error ${e} < 1`); }
  await context.close(); await canvas.context().close();
});

test("verifyGif refuses a page without ImageDecoder, naming the fix", async () => {
  const context = await browser.newContext();
  const blank = await context.newPage();
  await assert.rejects(verifyGif(blank, Buffer.alloc(0), []), /openCanvasPage/);
  await context.close();
});

test("vscode-targets: editorLines brackets the longest of those lines", async () => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // The two pieces of Monaco's DOM the resolver reads: line numbers and rendered lines, sharing their top.
  await page.setContent(`<div class="monaco-editor" style="font:14px monospace">
    ${[1, 2, 3].map(n => `<div class="line-numbers" style="position:absolute;left:0;top:${n * 20}px;height:20px">${n}</div>`).join("")}
    <div class="view-lines">${["short", "the longest line", "mid"].map((t, i) =>
      `<div class="view-line" style="position:absolute;left:40px;top:${(i + 1) * 20}px;height:20px"><span><span>${t}</span></span></div>`).join("")}</div></div>`);
  const r = await resolveEditorTarget(page, { editorLines: [1, 3] });
  const longest = await page.locator(".view-line span span", { hasText: "the longest line" }).boundingBox();
  assert.equal(r.bracket, true);
  assert.equal(r.x, longest.x + longest.width + 8);
  assert.deepEqual([r.y, r.height], [20, 60]);
  assert.equal(await resolveEditorTarget(page, { locator: null }), undefined, "other targets fall through");
  await context.close();
});

test("video: records a slice mid-session into a WebM, page left open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annotated-video-"));
  try {
    const { context, page, canvas } = await sitePage();
    const file = join(dir, "clip.webm");
    const recording = await startRecording(page, file, { size: viewport, actions: false });
    // Drawn right after start: headless Chromium's late first frame would leave this out.
    const [m] = await measureAll(page, [{ target: { locator: page.locator("#cta") }, text: "CTA", labelX: 520 }]);
    await annotate(page, [{ target: { locator: page.locator("#cta") }, text: "CTA", labelX: 520 }]);
    await page.waitForTimeout(800);
    await clearAnnotations(page);
    await page.click("#cta");
    await page.waitForTimeout(500);
    await recording.stop();
    assert.ok(existsSync(file) && statSync(file).size > 1000);
    assert.equal(readFileSync(file).readUInt32BE(0), 0x1a45dfa3, "EBML (WebM) header");
    assert.equal(page.isClosed(), false);
    const { duration, stills } = await videoStills(canvas, readFileSync(file), [0.2]);
    assert.ok(duration >= 1.1, `clip covers the recorded time (${duration} s)`);
    // The callout line runs from the button to the label at the button's vertical middle.
    const y = m.rect.y + m.rect.height / 2;
    assert.ok(near(await pixel(canvas, stills[0], (m.rect.x + 520) / 2, y), accent, 40), "callout visible 0.2 s in");
    await context.close(); await canvas.context().close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("video: whole-session recording through the context option", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annotated-video-"));
  try {
    const context = await browser.newContext({ viewport, ...recordingOptions(dir, viewport) });
    const page = await context.newPage();
    await page.goto(site);
    await page.waitForTimeout(300);
    const file = join(dir, "session.webm");
    await saveRecording(page, file, () => context.close());
    assert.equal(readFileSync(file).readUInt32BE(0), 0x1a45dfa3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frame capture: repaint frames become a GIF whose holds add up to the recorded time", async () => {
  const { context, page, canvas } = await sitePage();
  const callout = [{ target: { locator: page.locator("#cta") }, text: "CTA", labelX: 520 }];
  const [m] = await measureAll(page, callout);
  const capture = await startFrameCapture(page, { size: viewport, actions: false });
  const t0 = Date.now();
  // Drawn within the first burst of frames: the burst must keep this state, not the one before it.
  await annotate(page, callout);
  await page.waitForTimeout(600);
  await clearAnnotations(page);
  await page.click("#cta");
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(400);
  const frames = await capture.stop({ lastHoldMs: 1000 });
  const elapsed = Date.now() - t0;
  assert.ok(frames.length >= 2, `${frames.length} frames`);
  assert.ok(frames.every(f => f.png[0] === 0xff && f.png[1] === 0xd8), "frames are JPEG");
  let start = 0;
  const showing = frames.find(f => { const hit = start + f.holdMs > 300; start += f.holdMs; return hit; });
  // Inside the label box: solid accent colour, unlike the 2 px line, which JPEG blurs.
  assert.ok(near(await pixel(canvas, showing.png, 520 + 6, m.rect.y + m.rect.height / 2 - 8), accent, 40),
    "300 ms in, the GIF shows the callout drawn right after start");
  const recorded = frames.slice(0, -1).reduce((n, f) => n + f.holdMs, 0);
  assert.ok(recorded <= elapsed + 100, `holds (${recorded} ms) fit in the recorded time (${elapsed} ms)`);
  const gif = await encodeGif(canvas, frames);
  const check = await verifyGif(canvas, gif, frames);
  assert.equal(check.frameCount, frames.length);
  for (const e of check.keyFrameErrors) { assert.ok(e < 3, `frame error ${e} < 3`); }
  await context.close(); await canvas.context().close();
});

test("redaction onto a screenshot: every pixel it touches is the fill colour, at 1× and 2×", async () => {
  for (const scale of [1, 2]) {
    const { context, page, canvas } = await sitePage({ deviceScaleFactor: scale });
    const measured = await measureAll(page, [
      { target: { locator: page.locator("#cta") }, redact: true },
      { target: { locator: page.locator(".plan").nth(1) }, redact: "#2b6cb0" },
    ]);
    const png = await page.screenshot();
    const out = await annotateScreenshot(canvas, png, measured, { scale });
    for (const [m, fill] of [[measured[0], "0,0,0"], [measured[1], "43,108,176"]]) {
      assert.ok((await colours(canvas, png, m.rect.box, scale)).size > 1, "the source has something to hide there");
      assert.deepEqual([...(await colours(canvas, out, m.rect.box, scale)).keys()], [fill], `${scale}×: only ${fill} under the redaction`);
    }
    await context.close(); await canvas.context().close();
  }
});

test("redaction sits under callouts, whatever the order they're listed in", async () => {
  const { context, page, canvas } = await sitePage();
  const cta = page.locator("#cta");
  const [callout] = await measureAll(page, [{ target: { locator: cta }, text: "CTA", labelX: 520 }]);
  const y = callout.rect.y + callout.rect.height / 2;
  const out = await annotateScreenshot(canvas, await page.screenshot(), [
    callout,
    ...(await measureAll(page, [{ target: { rect: { x: 0, y: y - 30, width: viewport.width, height: 60 } }, redact: true }])),
  ]);
  assert.ok(near(await pixel(canvas, out, 520 + 6, y - 8), accent), "the label shows on top of the redaction");
  assert.ok(near(await pixel(canvas, out, 1000, y), black, 0), "the redaction covers the rest of the row");
  await context.close(); await canvas.context().close();
});

test("redaction on a fixed rectangle of an image no page is behind", async () => {
  const canvas = await openCanvasPage(await browser.newContext());
  // A stand-in for a screenshot someone took by hand.
  const png = Buffer.from(await canvas.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 420; c.height = 120;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#222"; ctx.font = "24px sans-serif"; ctx.fillText("Signed in as ada@example.com", 12, 50);
    return c.toDataURL("image/png").split(",")[1];
  }), "base64");
  const email = { x: 152.5, y: 26, width: 210, height: 34 };
  const out = await annotateScreenshot(canvas, png, await measureAll(canvas, [
    { target: { rect: email }, redact: "#7a1f2b" },
  ]));
  assert.ok((await colours(canvas, png, email)).size > 1, "the source has text there");
  assert.deepEqual([...(await colours(canvas, out, email)).keys()], ["122,31,43"]);
  await canvas.context().close();
});

test("redaction in a GIF from stills: covered in every decoded frame, fades and a moved target included", async () => {
  const { context, page, canvas } = await sitePage();
  // Not black: a frame whose pixels decode as transparent would read as black and pass.
  const fill = [0x2b, 0x6c, 0xb0];
  const cta = { target: { locator: page.locator("#cta") }, redact: "#2b6cb0" };
  const stills = [];
  const still = async ({ holdMs, fadeMs }) => {
    const measured = await measureAll(page, [cta]);
    stills.push({ png: await annotateScreenshot(canvas, await page.screenshot(), measured), holdMs, fadeMs, box: measured[0].rect.box });
  };
  await still({ holdMs: 400, fadeMs: 200 });
  await page.click("#cta");
  await still({ holdMs: 400 });
  await page.evaluate(() => scrollTo(0, 120));
  await still({ holdMs: 400 });
  assert.ok(stills[2].box.y < stills[1].box.y - 100, "the last still has the button somewhere else");
  const gif = await encodeGif(canvas, stills);
  const check = await verifyGif(canvas, gif, stills);
  for (const e of check.keyFrameErrors) { assert.ok(e < 1, `held frame error ${e} < 1`); }
  // Decoded frames: the first still, 4 fade steps into the second, the second, the third.
  const shownBox = [0, 0, 0, 0, 0, 1, 2].map(i => stills[i].box);
  assert.equal(check.frames.length, shownBox.length);
  for (const [i, frame] of check.frames.entries()) {
    const found = [...(await colours(canvas, frame, shownBox[i])).keys()];
    assert.equal(found.length, 1, `frame ${i}: one colour under the redaction, got ${found.length}`);
    assert.ok(near(rgb(found[0]), fill, 4), `frame ${i}: ${found[0]} is the fill`);
  }
  await context.close(); await canvas.context().close();
});

test("redaction as a live overlay: covers and hides the element until clearAnnotations; refuses a see-through colour", async () => {
  const { context, page, canvas } = await sitePage();
  const cta = page.locator("#cta");
  await cta.evaluate(el => { el.style.opacity = "0.9"; });
  await annotate(page, [{ target: { locator: cta }, redact: true }]);
  const box = await cta.boundingBox();
  assert.deepEqual([...(await colours(canvas, await page.screenshot(), box)).keys()], ["0,0,0"]);
  assert.equal(await cta.evaluate(el => getComputedStyle(el).opacity), "0", "the element itself is hidden too");
  await clearAnnotations(page);
  assert.equal(await cta.evaluate(el => el.style.opacity), "0.9", "its own opacity is back");
  for (const fill of ["transparent", "rgba(0, 0, 0, 0.5)", "#nope", "var(--unset)"]) {
    await assert.rejects(annotate(page, [{ target: { locator: cta }, redact: fill }]), /opaque/, fill);
    assert.equal(await page.locator("#annotated-screenshots-overlay").count(), 0, `nothing drawn for ${fill}`);
  }
  await context.close(); await canvas.context().close();
});

test("redaction while recording: drawn before capture starts, the element shows in no frame, scrolling included", async () => {
  const { context, page, canvas } = await sitePage();
  const redaction = { target: { locator: page.locator("#cta") }, redact: true };
  await annotate(page, [redaction]);
  const box = await page.locator("#cta").boundingBox();
  const capture = await startFrameCapture(page, { size: viewport, actions: false });
  // Callouts come and go by replacing the drawing; clearAnnotations would also show the element.
  await annotate(page, [redaction, { target: { locator: page.locator("#cta") }, text: "Redacted", labelX: 520 }]);
  await page.waitForTimeout(300);
  await annotate(page, [redaction]);
  await page.mouse.wheel(0, 120); // the cover stays where the button was; the button scrolls up
  await page.waitForTimeout(500);
  const frames = await capture.stop();
  await clearAnnotations(page);
  assert.ok(frames.length >= 2, `${frames.length} frames`);
  assert.ok(near(await pixel(canvas, frames[0].png, box.x + box.width / 2, box.y + box.height / 2), black, 16), "the first frame has the cover");
  for (const [i, f] of frames.entries()) {
    const red = [...(await colours(canvas, f.png)).entries()].filter(([c]) => near(rgb(c), ctaRed)).reduce((n, [, count]) => n + count, 0);
    assert.equal(red, 0, `frame ${i}: ${red} pixels of the button's red`);
  }
  await context.close(); await canvas.context().close();
});

test("draw.mjs's default style is the accent the pixel checks expect", () => {
  assert.equal(DEFAULT_STYLE.accent, "#ffb02e");
});
