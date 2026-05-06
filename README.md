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

## License

MIT
