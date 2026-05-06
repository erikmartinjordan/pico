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

<!--
  This badge uses GitHub's repository-wide release-asset download total.
  The release workflow keeps every automatic release instead of deleting and recreating
  a single `latest` release, so historical downloads remain available to the badge.
-->

Lightweight screen-capture & annotation app for **macOS** and **Windows**. Modern, fast, and portable.


## Features

- **Cross-platform** — Native apps for macOS (Intel & Apple Silicon) and Windows
- **Multi-monitor capture** — Seamlessly capture across all connected displays
- **Region selection** — Drag to crop the exact area you need
- **Window container** — Wrap screenshots in a macOS-style window chrome
- **Annotation tools**
  - Rectangle & Ellipse
  - Arrow & Line
  - Text labels
  - Highlighter
  - Blur/pixelate sensitive info
- **Color palette** — 9 preset colors + custom color picker
- **Adjustable stroke width** — 4 thickness options
- **Undo/Redo** — Full history support
- **Zoom & pan** — Navigate large screenshots with ease
- **Export options** — Save to PNG or copy directly to clipboard
- **Portable** — Single executable, no installation required (Windows)

### Pro features

- **Scrolling capture (Pro)** — `scrollCapture(windowId: string): Promise<Buffer>` auto-scrolls a selected desktopCapturer window source and stitches frames with a 20px overlap plus seam diff check. The toolbar flow now lets you choose a window instead of manually pasting a source id.
- **Screen recording (Pro)** — `startRecording()` records screen video plus system audio as `video/webm;codecs=vp9` when available; `stopRecording({ gif?: boolean })` converts the result to MP4 through bundled `ffmpeg` and can export a GIF through bundled `gifski`. If system audio or local converters are unavailable, pico falls back gracefully and reports the limitation.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+S` | Capture screen |
| `Cmd/Ctrl+O` | Open image |
| `Cmd/Ctrl+E` | Export PNG |
| `Cmd/Ctrl+C` | Copy to clipboard |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `R` | Rectangle tool |
| `E` | Ellipse tool |
| `A` | Arrow tool |
| `L` | Line tool |
| `T` | Text tool |
| `H` | Highlight tool |
| `B` | Blur tool |
| `W` | Window container |
| `+` / `-` | Zoom in/out |
| `0` | Fit to window |
| Shift-click Record (Pro) stop | Export MP4 and GIF |

## Download

Grab the latest release for your platform:

- **macOS**: `pico-universal.dmg` and `pico-arm64.zip` / `pico-x64.zip`
- **Windows**: `pico-portable.exe` (Portable, no install needed)

> **Windows first-run note:** because current releases are not yet Authenticode-signed, Windows SmartScreen may show a warning the first time you launch pico. Click **More info → Run anyway** to continue. Signed releases are planned for a future version.

[Download latest release →](../../releases/latest)

## Development

### Prerequisites

- Node.js 20+ 
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm start
```

### Build

```bash
# Build for current platform
npm run build

# Build for macOS
npm run build:mac

# Build a legacy Intel DMG for macOS 10.13+ without changing the default Electron build
npm run build:mac:legacy

# Build for Windows  
npm run build:win

# Build for all platforms
npm run build:all
```

Built apps are output to the `dist/` folder.

### Code signing (Windows)

Electron Builder supports optional Authenticode signing in CI when certificate secrets are configured:

```bash
# Base64-encoded .p12 certificate
export CSC_LINK=<base64-p12>
export CSC_KEY_PASSWORD=<p12-password>
# Keep local/unsigned builds working when no certificate is configured
export CSC_IDENTITY_AUTO_DISCOVERY=false
```

> TODO: For production releases, use a DigiCert or Sectigo Authenticode OV/EV certificate and configure `signingHashAlgorithms: ["sha256"]`. EV certificates typically establish SmartScreen reputation faster than OV certificates.


## Project Structure

```
pico/
├── package.json          # Dependencies & build config
├── src/
│   ├── main.js           # Electron main process
│   ├── preload.js        # IPC bridge
│   ├── index.html        # Main window UI
│   ├── styles.css        # Styling
│   ├── renderer.js       # UI logic & canvas drawing
│   ├── capture-overlay.html  # Screen capture overlay
│   └── assets/
│       └── icons/        # App icons (macOS, Windows, Linux)
└── dist/                 # Built applications
```

## Design

Dark theme with an orange accent:

| Token | Value | Usage |
| --- | --- | --- |
| Background | `#09090b` | App background |
| Surface | `#1e1f24` | Toolbar, panels |
| Accent | `#f07d20` | Active states, buttons |
| Accent soft | `#ffaa55` | Hover, highlights |
| Text | `#f5f0eb` | Primary text |
| Muted | `#6b6560` | Secondary text |

Typography: DM Mono / system monospace at 10–13px.

## Tech Stack

- **Electron** — Cross-platform desktop framework
- **Canvas API** — Hardware-accelerated drawing
- **desktopCapturer** — Native screen capture

## License

MIT
