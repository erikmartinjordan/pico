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

pico is a minimal screen capture and annotation app for Windows, Linux, and experimental macOS builds.

## Download

[Download the latest release](../../releases/latest)

Recommended launch targets:

- Windows: portable EXE
- Linux: AppImage
- macOS: experimental unsigned DMG/ZIP for technical users only

> Windows may show a SmartScreen warning on first launch because releases are not yet signed.
>
> macOS builds are intentionally unsigned and not notarized until pico can fund an Apple Developer Program account. Recent macOS versions can block unsigned apps and require manual approval in System Settings. If you are not comfortable with that security tradeoff, use the Windows/Linux builds or build pico from source on a Mac you control.

### macOS status

The native macOS app is not the primary launch target right now. It is useful for testing, but it has two known limitations:

1. Gatekeeper can make unsigned, unnotarized apps difficult or impossible for mainstream users to open.
2. Screen capture requires Screen Recording permission in System Settings → Privacy & Security → Screen & System Audio Recording. pico now detects denied permission and opens the correct settings pane with recovery instructions.

If you test the macOS build, download it only from the official GitHub release, verify checksums when provided, and expect to quit and reopen pico after changing Screen Recording permission.

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
npm run build          # current platform
npm run build:desktop  # Windows and Linux launch artifacts
npm run build:win      # Windows portable EXE
npm run build:linux    # Linux AppImage
npm run build:mac      # experimental unsigned macOS artifacts
npm run build:all      # macOS, Windows, and Linux
```

Builds are written to `dist/`.

## Release strategy

pico's no-budget launch path is to treat Windows and Linux as the primary downloadable platforms while keeping macOS transparent and experimental until notarization is affordable.

Before publishing a release:

- Build Windows portable EXE and Linux AppImage as the main artifacts.
- Publish SHA-256 checksums for every artifact.
- Label macOS artifacts as unsigned and unnotarized.
- Keep the GitHub release page as the only official binary download source.
- Fund Apple Developer Program membership before marketing macOS as a polished one-click app.

## License

MIT
