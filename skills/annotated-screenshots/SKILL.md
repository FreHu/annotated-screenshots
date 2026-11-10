---
name: annotated-screenshots
description: Make annotated screenshots (callouts, numbered markers, outlines), demo GIFs and screen recordings of a website or a VS Code extension with Playwright, for READMEs, docs, store listings, audit evidence or bug reports. Also annotates an existing screenshot. Use when asked for screenshots, a demo GIF, a walkthrough, a recording, or to point things out on an image.
---

# Annotated screenshots, GIFs and recordings

The code is in `lib/`, next to this file. **Copy the files the task needs into the project** (e.g. `scripts/screenshots/`); don't import them from here. The project must build without this skill installed. Keep the version line at the top of each copied file, so drift from the published version shows.

| File | What it does | Needs |
|---|---|---|
| `lib/draw.mjs` | the drawing (runs inside the page) | — |
| `lib/targets.mjs` | target → rectangle | — |
| `lib/annotate.mjs` | `annotate` (live overlay), `measureAll` + `annotateScreenshot` (onto a finished PNG), `openCanvasPage` | draw, targets |
| `lib/gif.mjs` | `encodeGif`, `verifyGif` | npm `gifenc@1.0.3` |
| `lib/shrink-gif.mjs` | CLI: scale down / drop frames of an existing GIF | gif, npm `omggif@1.0.10` |
| `lib/video.mjs` | `startRecording` (WebM), `startFrameCapture` (frames for a GIF), `videoStills`, whole-session `recordingOptions` + `saveRecording` | Playwright 1.64+ |
| `lib/vscode-targets.mjs` | `editorLine` / `editorLines` / `editorGutter` targets for VS Code's editor | — |

The project brings its own `playwright` (websites) or `playwright-core` (Electron / VS Code).

## Pick a mode

- **Onto the finished screenshot** (`measureAll` → `page.screenshot()` → `annotateScreenshot(canvas, png, measured)`). The default for websites. The page's CSS can't touch the drawing, and full-page captures work (`measureAll(…, { fullPage: true })`). The clean PNG stays untouched; keep it when the screenshot is evidence. With a [redaction](#redaction) it is also the file not to publish. This mode also annotates an image from elsewhere: give targets as `{ rect: {x, y, width, height} }` in image pixels.
- **Live overlay** (`annotate(page, …)`, then your own `page.screenshot()`, then `clearAnnotations`). Needed for video, and for Electron apps, which have no second page to draw in.

`canvas` comes from `openCanvasPage(context)`, in a context with `deviceScaleFactor: 1`. For a capture taken at `deviceScaleFactor: 2`, pass `{ scale: 2 }`.

## Annotations

- `{ target, text, labelX }`: callout to a label at x
- `{ target, text, above | below }`: label that many px above or below
- `{ target, marker: 1 }`: numbered circle
- `{ target, box: true, text?, above?|below? }`: outline
- `{ target, redact: true }`: opaque cover in `style.redaction` (default black); `redact: "#fff"` for another colour. Add `text`, `marker` or `box` to label it. See [Redaction](#redaction).

Targets: `{ locator }`, `{ locators: [a, b] }` (box around several), `{ rect }`, or an adapter's own targets via `{ resolve }` (e.g. `resolveEditorTarget`). Targets are measured from the live page, so a rerun after a UI change still points at the right element. Never hard-code coordinates for a live page.

## Redaction

For what demo data can't replace: an email in a screenshot someone took by hand, a signed-in account in a title bar.
- **An opaque fill, never a blur or pixelation**: those can sometimes be reversed. A colour that is invalid or not fully opaque is refused with an error.
- **Drawn under every callout**, whatever the order of the list, so a label can sit on a redacted area and a redaction never hides a label.
- **Onto a finished screenshot:** every pixel the target's box touches becomes the fill colour (edges round outwards to whole pixels). **Publish only the annotated output.** The clean screenshot still shows what is covered: keep it private, or don't write it to disk. For an image from elsewhere, use `{ rect }` in image pixels.
- **The cover is the target's box.** Text that overflows its element shows beside it. Target the element that contains it, or `{ locators: [a, b] }` for a box around both.
- **GIFs:** draw the redaction into every still. A frame stores only the pixels that changed; the rest shows the frame before, which had the same colour there. So a redaction in every still is covered in every frame, crossfades included. Check the frames `verifyGif` returns.
- **Live overlay (video, Electron):**
  - Call `annotate` with the redaction **before** `startRecording` / `startFrameCapture`. It returns once the cover is painted, so no frame shows the element.
  - The cover stays where the element was measured. The element itself is also made transparent until `clearAnnotations`, so scrolling or a layout change can't move it out from under the cover. A `{ rect }` redaction has no element to hide: it covers a fixed area of the viewport only.
  - To change callouts between steps, call `annotate` again with the redaction in the list. It swaps the drawing in one step. `clearAnnotations` shows the element again.
  - A page that re-renders the element (a new DOM node) shows the new one. Annotate again after such a step, and check the recording's stills.

## GIFs

A scene is a list of frames `{ png, holdMs, fadeMs? }` → `encodeGif(canvas, frames)`. Each frame stores only the pixels that changed, so a held screen costs little.
- **Always run `verifyGif`**, save its decoded frames as PNGs, and look at them. Image viewers, and reading the GIF file, show only the first frame. `keyFrameErrors` above ~2 (on a 0–255 scale) means held frames don't match their stills.
- GIF is the one animated format that GitHub READMEs, the VS Code Marketplace and Open VSX all play. It has 256 colours per frame: fine for UI, but photos and gradients show visible banding. For photo-heavy pages, prefer stills or a video. Before choosing animated WebP or APNG, check that the destination renders them.
- Keep width ≤ ~1100 px and frames few. Shrink an existing GIF with `node shrink-gif.mjs in.gif out.gif --width 900 --every 2`.

## Video (with caveats)

Built on `page.screencast` (Playwright 1.64+), which records any stretch of a session. Works on websites and on Electron apps (VS Code).
- **A clip:** load the page, `const rec = await startRecording(page, "clip.webm", { size })`, do the steps, `await rec.stop()`. The page stays open, so one session can give several clips.
- **A GIF from the real thing:** `startFrameCapture(page)` … `stop()` returns frames for `encodeGif`. Each frame is held as long as the page showed it. Use this instead of hand-picked stills when the motion matters.
- **Pointer:** by default Playwright draws a pointer that moves from one action to the next (`actions: false` turns it off). Playwright also labels it with the call ("Click locator('#cta')"); that label is hidden for demos.
- **Check a recording by its stills:** `videoStills(canvas, webmBytes, [0.5, 2])`, then look at them. You can't watch the video.

Caveats:
- **Headless Chromium sends the first frame ~2 s after the screencast starts.** The start functions wait for it, so nothing done after they return is lost. If you call `page.screencast.start` directly, add the same wait.
- **Frames come only when the page repaints.** A still page costs nothing; the WebM repeats the last frame to keep its frame rate.
- **WebM (VP8) only.** MP4 needs your own ffmpeg; Playwright's bundled one is built for its own use.
- **Actions are instant.** Add `waitForTimeout` pauses so each step can be seen.
- **Annotations work only as the live overlay** (`annotate`), not drawn onto a finished screenshot.
- `recordingOptions` + `saveRecording` use the `recordVideo` context option. They record from page creation, popups included, and finish the file only when the context closes. Use them for debugging, not demos.
- Before choosing video, check that the destination plays it. README renderers and extension stores often play only video uploaded through their own editor, or none at all. When in doubt, use a GIF: it plays everywhere.

## Websites

- Wait for `document.fonts.ready`. Scroll through lazy-loaded pages before a full-page capture. Take screenshots with `animations: "disabled"`. Dismiss consent banners and chat widgets first, or mark them as out of scope.
- Sticky headers, `transform`ed sections and global CSS resets break drawings made inside the page. Drawing onto the finished screenshot avoids all three.
- Use a local fixture page for examples and tests, never a third-party site.

## VS Code extensions

- Launch a pinned VS Code build (`@vscode/test-electron` downloads one) with `_electron.launch({ executablePath, args: [workspace, "--extensionDevelopmentPath=…", "--user-data-dir=<fresh>", "--extensions-dir=<fresh>", "--disable-workspace-trust"] })`. Use a fresh profile per scene, so view state doesn't leak between scenes.
- **Strip `ELECTRON_*` and `VSCODE_*` from the environment.** A VS Code terminal sets `ELECTRON_RUN_AS_NODE`, which makes Code.exe start as plain Node.
- The workbench enforces Trusted Types: build DOM with DOM calls, never HTML strings (`draw.mjs` does this).
- Webviews are nested iframes (`iframe.webview.ready` → `#active-frame`). Playwright's `boundingBox()` already returns main-frame coordinates for them.
- Use the live overlay mode. The workbench page is a secure context, so `encodeGif` and `verifyGif` can run in it directly.

## Electron apps you don't build

Installed apps (Cursor, TIDAL, Slack, …) can be driven too. Tested on Cursor and TIDAL on Windows.
- **Always use a throwaway `--user-data-dir`.** It keeps the user's accounts and messages off screen. Without it, a single-instance app hands the launch over to the copy already running.
- **Full control:** `_electron.launch({ executablePath, args: ["--user-data-dir=<throwaway>"] })`. Needs the app's `EnableNodeCliInspectArguments` fuse on; check with `npx @electron/fuses read --app <exe>`.
- **Window only, works without that fuse:** start the app yourself with `--remote-debugging-port=<port> --user-data-dir=<throwaway>`, then `chromium.connectOverCDP("http://127.0.0.1:<port>")`. Screenshots, locators, annotations and `page.screencast` all work.
- **Wait for the app's own UI before capturing** (e.g. `.monaco-workbench` for VS Code forks, a known element for others), then look at the image. Right after attaching, a window can already show its final title while painting only its background colour.
- A copy that's already running can't be attached to unless it was started with a debugging port.
- Squirrel is the auto-updating installer many Electron apps use on Windows (Slack, Discord, TIDAL). It puts a small launcher at `%LOCALAPPDATA%\<App>\<App>.exe`, which starts the newest `app-<version>\<App>.exe` and exits. Launch the versioned exe directly. Otherwise Playwright attaches to the launcher, which has already exited.
- WebView2 apps (Windows apps that embed Microsoft's Edge engine, e.g. WhatsApp Desktop) aren't Electron. They read Chromium flags from the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable. Set it to `--remote-debugging-port=<port>` for the app's launch, then attach over CDP as above. Tested on WhatsApp Desktop: one page (`https://web.whatsapp.com`), screencast works.
  - Explorer launches a Store (MSIX) app that has no execution alias, so a variable set in your own process doesn't reach it. Instead:
    1. Set the variable on the user account: `[Environment]::SetEnvironmentVariable(…, 'User')`.
    2. Broadcast `WM_SETTINGCHANGE`, so Explorer reloads its environment.
    3. Launch via `explorer shell:AppsFolder\<PackageFamilyName>!App`.
    4. Remove the variable straight away. Every WebView2 app started while it's set opens the same port.
  - Such apps can't get a throwaway profile, because their data lives inside the package. Attaching exposes the user's real account. Ask first, capture nothing private, and close the app afterwards: an open debugging port lets any local process read it.
- **VS Code as the user has it** (their extensions and setup, not only an extension they build): start the installed `Code.exe` as a second instance with `--remote-debugging-port=<port> --user-data-dir=<throwaway> --extensions-dir=<their extensions folder, e.g. ~/.vscode/extensions>`, and attach over CDP. In the throwaway profile's `settings.json`, set `extensions.autoUpdate: false`, `extensions.autoCheckUpdates: false` and `update.mode: "none"`. The second instance then leaves the shared extensions folder alone. Tested: the user's extensions load, and screenshots and recording work.
- **The VS Code the user is working in can't be attached to.** It wasn't started with a debugging port. Restarting it would end whatever runs inside it, including an agent session in an extension. Use the second instance above.
- **A VS Code extension in isolation:** a pinned VS Code with a throwaway `--user-data-dir` and `--extensions-dir`. Install the extension into that dir (`code --extensions-dir <dir> --install-extension <publisher.name>`). No Extension Development Host needed.

## Before publishing an image

- Demo data uses invented people and companies. Before publishing, check every image for the real user's name, email, file paths, avatars or account details. Tools often show them unasked: a git identity on pending changes, a signed-in account in a title bar. What can't be replaced gets a [redaction](#redaction).
- Look at every output PNG (and every GIF frame) yourself before calling it done.
- Make generation a script in the project that regenerates every image. Time each scene by phase (setup, launch, capture, encode, verify), so a slow scene shows where its time goes.
