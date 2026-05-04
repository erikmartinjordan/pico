# pico

![Total downloads](https://img.shields.io/github/downloads/erikmartinjordan/pico/total?label=Total%20downloads&style=flat-square)

Lightweight screen-capture & annotation app for **macOS** and **Windows**. Modern, fast, and portable.


## Features

- **Cross-platform** — Native apps for macOS (Intel & Apple Silicon) and Windows
- **Multi-monitor capture** — Seamlessly capture across all connected displays
- **Region selection** — Drag to crop the exact area you need
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
| `+` / `-` | Zoom in/out |
| `0` | Fit to window |

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
│       └── icons/        # App icons
└── dist/                 # Built applications
```

## Design

Dark theme with a clean, modern aesthetic:

| Token | Value | Usage |
| --- | --- | --- |
| Background | `#0a0a0b` | App background |
| Surface | `#111113` | Toolbar, panels |
| Accent | `#3b82f6` | Active states, buttons |
| Text | `#fafafa` | Primary text |
| Muted | `#71717a` | Secondary text |

Typography: System fonts (-apple-system, Segoe UI) at 12–14px.

## Tech Stack

- **Electron** — Cross-platform desktop framework
- **Canvas API** — Hardware-accelerated drawing
- **desktopCapturer** — Native screen capture

## License

MIT
