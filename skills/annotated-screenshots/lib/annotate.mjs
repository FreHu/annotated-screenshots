// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Two ways to draw the same annotations:
//   annotate(page, …)            live overlay on the page itself; take the screenshot (or record video) yourself
//   annotateScreenshot(page, …)  onto a finished screenshot in a blank page; the source PNG stays untouched
// Prefer annotateScreenshot when the screenshot is evidence, when the page's own CSS or a
// full-page capture would get in the way, or when the image comes from elsewhere.
// With a redaction, only the output is safe to share: the source still shows what it covers.

import { DEFAULT_STYLE, drawAnnotations } from "./draw.mjs";
import { measure } from "./targets.mjs";

const ROOT_ID = "annotated-screenshots-overlay";
const HIDDEN_ATTR = "data-annotated-screenshots-hidden";

/**
 * An annotation: `{ target, text?, labelX?, above?, below?, marker?, box?, redact? }`.
 *   `text` with `labelX`: callout label at that x, level with the target.
 *   `text` with `above` / `below`: label that many px above or below the target.
 *   `marker: n`: numbered circle on the target. `box: true`: outline (label to its right).
 *   `redact: true` or a CSS colour: covers the target with an opaque fill (default `style.redaction`),
 *   drawn under every callout. Combine with `text`, `marker` or `box` to label the covered area.
 * `target`: see targets.mjs.
 */

/** Measures every annotation's target. Pass the result to annotateScreenshot after capturing. */
export async function measureAll(page, annotations, options) {
  const out = [];
  for (const a of annotations) {
    const { target, ...rest } = a;
    out.push({ ...rest, rect: await measure(page, target, options) });
  }
  return out;
}

/**
 * Draws over the live page, replacing what an earlier call drew. Remove with clearAnnotations
 * before the next frame.
 * A redacted `locator` / `locators` target is also made transparent (opacity 0) until
 * clearAnnotations: the cover stays where the element was measured, and the element could
 * scroll or move out from under it, or sit in the top layer above it. Returns once the
 * browser has painted the redaction, so a recording started afterwards never shows the element.
 * @param {{ style?: object, resolve?: Function }} [options]
 */
export async function annotate(page, annotations, { style = DEFAULT_STYLE, resolve } = {}) {
  const items = await measureAll(page, annotations, { resolve });
  await page.evaluate(drawAnnotations, { items, style, rootId: ROOT_ID, mode: "overlay" });
  const redactions = annotations.filter(a => a.redact);
  if (redactions.length === 0) { return; }
  for (const locator of redactions.flatMap(a => a.target.locators ?? (a.target.locator ? [a.target.locator] : []))) { await locator.evaluate(hideElement, HIDDEN_ATTR); }
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 500); // a background tab gets no animation frames, nor paints
  }));
}

/** Removes the drawing and shows the elements annotate() hid, in every frame. */
export async function clearAnnotations(page) {
  await page.evaluate(id => document.getElementById(id)?.remove(), ROOT_ID);
  for (const frame of page.frames()) {
    await frame.evaluate(showHidden, HIDDEN_ATTR).catch(err => { if (frame === page.mainFrame()) { throw err; } });
  }
}

// Both run in the page. The inline opacity is kept in the attribute, so clearing restores it.
function hideElement(el, attr) {
  if (!el.hasAttribute(attr)) {
    el.setAttribute(attr, JSON.stringify([el.style.getPropertyValue("opacity"), el.style.getPropertyPriority("opacity")]));
  }
  el.style.setProperty("opacity", "0", "important");
}

function showHidden(attr) {
  for (const el of document.querySelectorAll(`[${attr}]`)) {
    const [value, priority] = JSON.parse(el.getAttribute(attr));
    if (value) { el.style.setProperty("opacity", value, priority); } else { el.style.removeProperty("opacity"); }
    el.removeAttribute(attr);
  }
}

/**
 * Draws measured annotations onto a PNG or JPEG screenshot and returns a PNG of the same size.
 * @param {import("playwright").Page} canvasPage from openCanvasPage (not the page being documented)
 * @param {Buffer} png the screenshot (PNG or JPEG)
 * @param {object[]} measured from measureAll (rects in CSS pixels of the captured page)
 * @param {{ scale?: number, style?: object }} [options] `scale`: image pixels per CSS pixel, i.e. the
 *   capture's deviceScaleFactor (default: 1)
 */
export async function annotateScreenshot(canvasPage, png, measured, { scale = 1, style = DEFAULT_STYLE } = {}) {
  const { width, height } = imageSize(png);
  await canvasPage.setViewportSize({ width, height });
  await canvasPage.setContent("<!doctype html><html><body style=\"margin:0\"></body></html>");
  await canvasPage.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    img.style.display = "block";
    document.body.append(img);
  }, `data:${imageType(png)};base64,${png.toString("base64")}`);
  await canvasPage.evaluate(drawAnnotations, { items: measured, style, rootId: ROOT_ID, mode: "compose", scale });
  const out = await canvasPage.screenshot({ clip: { x: 0, y: 0, width, height } });
  const got = pngSize(out);
  if (got.width !== width || got.height !== height) {
    throw new Error(`annotated image is ${got.width}×${got.height}, source ${width}×${height}: use a canvas page with deviceScaleFactor 1`);
  }
  return out;
}

/**
 * A blank page to draw and decode in (annotateScreenshot, encodeGif, verifyGif). It is
 * served from a routed https:// origin because verifyGif's ImageDecoder exists only in a
 * secure context, which about:blank is not in headless Chromium. Nothing leaves the machine.
 * @param {import("playwright").BrowserContext} context one with deviceScaleFactor 1
 */
export async function openCanvasPage(context) {
  const page = await context.newPage();
  const url = "https://annotated-screenshots.invalid/";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body style=\"margin:0\"></body></html>" }));
  await page.goto(url);
  return page;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) { throw new Error("not a PNG"); }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function imageType(bytes) {
  if (bytes.readUInt32BE(0) === 0x89504e47) { return "image/png"; }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) { return "image/jpeg"; }
  throw new Error("annotateScreenshot takes a PNG or JPEG screenshot");
}

/** Width and height of a PNG, or of a JPEG from its start-of-frame marker. */
export function imageSize(bytes) {
  if (imageType(bytes) === "image/png") { return pngSize(bytes); }
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    // SOF0–SOF15 hold the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error("JPEG without a start-of-frame marker");
}
