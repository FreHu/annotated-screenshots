// Example: annotated screenshots, a demo GIF and (with --video) a screen recording of a website.
// Usage: npm run example [-- --video] [-- --out docs/img]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { annotate, annotateScreenshot, clearAnnotations, measureAll, openCanvasPage } from "../skills/annotated-screenshots/lib/annotate.mjs";
import { encodeGif, verifyGif } from "../skills/annotated-screenshots/lib/gif.mjs";
import { startFrameCapture, startRecording } from "../skills/annotated-screenshots/lib/video.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : join(here, "out"));
mkdirSync(out, { recursive: true });
const site = pathToFileURL(join(here, "fixture-site", "index.html")).href;
const viewport = { width: 1100, height: 700 };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport });
const page = await context.newPage();
const canvas = await openCanvasPage(context); // drawing and decoding surface
await page.goto(site);
await page.evaluate(() => document.fonts.ready);

// The signed-in account's email, covered in every image below.
const account = { target: { locator: page.locator("#account") }, redact: true };

// 1. Full-page screenshot, annotated afterwards. The clean capture stays as it was taken,
// email included: full-page-annotated.png is the one to publish, full-page.png is not.
const measured = await measureAll(page, [
  { ...account, text: "Account redacted", below: 14 },
  { target: { locator: page.locator("#cta") }, text: "One call to action above the fold", labelX: 520 },
  { target: { locators: [page.locator(".plan").nth(1)] }, box: true, text: "Most popular plan", above: 8 },
  { target: { locator: page.locator("#refund") }, text: "Refund terms sit 900 px below the plans", above: 46 },
], { fullPage: true });
const clean = await page.screenshot({ fullPage: true });
writeFileSync(join(out, "full-page.png"), clean);
writeFileSync(join(out, "full-page-annotated.png"), await annotateScreenshot(canvas, clean, measured));

// 2. A three-frame GIF, annotated with the live overlay.
const frames = [];
await annotate(page, [account, { target: { locator: page.locator("#cta") }, text: "1. Start a trial", labelX: 520 }]);
frames.push({ png: await page.screenshot(), holdMs: 1600, fadeMs: 300 });
await clearAnnotations(page);
await page.click("#cta");
await annotate(page, [account, { target: { locator: page.locator("#signup-form p") }, text: "2. Confirmation shows inline", above: 40 }]);
frames.push({ png: await page.screenshot(), holdMs: 1600, fadeMs: 300 });
await clearAnnotations(page);
await page.locator("#plans").scrollIntoViewIfNeeded();
await annotate(page, [
  account,
  { target: { locator: page.locator(".plan").nth(0) }, marker: 1 },
  { target: { locator: page.locator(".plan").nth(1) }, marker: 2 },
  { target: { locator: page.locator(".plan").nth(2) }, marker: 3 },
]);
frames.push({ png: await page.screenshot(), holdMs: 2000 });
const gif = await encodeGif(canvas, frames);
const check = await verifyGif(canvas, gif, frames);
writeFileSync(join(out, "trial-flow.gif"), gif);
mkdirSync(join(out, "frames"), { recursive: true });
check.frames.forEach((png, i) => writeFileSync(join(out, "frames", `${String(i + 1).padStart(2, "0")}.png`), png));
console.log(`trial-flow.gif: ${check.frameCount} frames, ${Math.round(gif.length / 1024)} KB; held-frame error vs stills (0–255): ${check.keyFrameErrors.join(", ")}`);
await context.close();

// 3. Optional: the same flow recorded, as a WebM and as a GIF built from the recorded frames.
// The page load happens before recording starts, so neither shows it.
if (args.includes("--video")) {
  const rec = await browser.newContext({ viewport });
  const p = await rec.newPage();
  const recCanvas = await openCanvasPage(rec);
  const recAccount = { target: { locator: p.locator("#account") }, redact: true };
  // The redaction goes on before recording starts, and stays: the callout is replaced by
  // annotating with the redaction alone, since clearAnnotations would show the email again.
  const flow = async () => {
    await p.goto(site);
    await p.evaluate(() => document.fonts.ready);
    await annotate(p, [recAccount]);
    return p;
  };
  const act = async () => {
    await annotate(p, [recAccount, { target: { locator: p.locator("#cta") }, text: "Start a trial", labelX: 520 }]);
    await p.waitForTimeout(900);
    await annotate(p, [recAccount]);
    await p.click("#cta");
    await p.waitForTimeout(1000);
    await p.locator("#plans").scrollIntoViewIfNeeded();
    await p.waitForTimeout(800);
  };
  await flow();
  const recording = await startRecording(p, join(out, "trial-flow.webm"), { size: viewport });
  await act();
  await recording.stop();
  await flow();
  const capture = await startFrameCapture(p, { size: viewport });
  await act();
  const recorded = await capture.stop();
  const recordedGif = await encodeGif(recCanvas, recorded);
  writeFileSync(join(out, "trial-flow-recorded.gif"), recordedGif);
  mkdirSync(join(out, "recorded-frames"), { recursive: true });
  recorded.forEach((f, i) => writeFileSync(join(out, "recorded-frames", `${String(i + 1).padStart(2, "0")}.jpg`), f.png));
  console.log(`trial-flow.webm, trial-flow-recorded.gif: ${recorded.length} frames, ${Math.round(recordedGif.length / 1024)} KB`);
  await rec.close();
}

await browser.close();
console.log(`output: ${out}`);
