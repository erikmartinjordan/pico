# pico

<p align="center">
  <img src="src/assets/icons/macos/256x256.png" alt="pico icon" width="128" height="128" />
</p>

<p align="center">
  <strong>Capture, annotate, share.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/downloads/erikmartinjordan/pico/total?label=Total%20downloads&style=flat-square" alt="Total downloads" />
</p>

pico is a minimal screen capture and annotation app for macOS and Windows.

## Download

[Download the latest release](../../releases/latest)

- macOS: universal DMG, arm64 ZIP, x64 ZIP, or legacy Intel DMG
- Windows: portable EXE

> Windows may show a SmartScreen warning on first launch because releases are not yet signed.

## Features

- Capture a region, window, or display
- Annotate with shapes, arrows, text, highlight, and blur
- Undo, redo, zoom, and pan
- Save as PNG or copy to clipboard
- Pro tools: scrolling capture and screen recording

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+S` | Capture screen |
| `Cmd/Ctrl+O` | Open image |
| `Cmd/Ctrl+E` | Export PNG |
| `Cmd/Ctrl+C` | Copy to clipboard |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `R`, `E`, `A`, `L`, `T`, `H`, `B`, `W` | Select annotation tools |
| `+` / `-` | Zoom in/out |
| `0` | Fit to window |

## Development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm start
```

Build the app:

```bash
npm run build        # current platform
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:all    # macOS and Windows
```

Builds are written to `dist/`.


## Automated capture testing

pico includes an Electron end-to-end suite for the manual flows that are easiest to regress:

- rectangle/region capture
- window capture
- fullscreen capture
- MP4 recording export
- GIF recording export

Run the suite locally:

```bash
npm run test:capture
```

Run with visible windows for debugging:

```bash
npm run test:capture:headed
```

On Linux CI or headless Linux machines, run the same command through `xvfb-run` so Electron has a desktop to capture:

```bash
xvfb-run -a npm run test:capture
```

The suite launches the real Electron app, clicks the capture and recording buttons, interacts with the capture overlays, and verifies that the canvas or exported recording file exists. During tests only, `PICO_E2E=1` enables non-production helpers that avoid save dialogs, automatically choose a recording source, and provide a window-capture fallback when the OS cannot enumerate normal windows in CI.

If you want an automated fixing agent to run after a failure, use:

```bash
npm run test:capture:agent
```

That command runs `npm run test:capture`, writes failures to `.pico-agent/capture-e2e-failure.log`, invokes the installed `codex exec` CLI by default, then reruns the suite. If `codex` is not on your `PATH`, or to use a different local agent command, set `PICO_FIX_AGENT_COMMAND`; the failure prompt is sent to the command on stdin.

## License

MIT
