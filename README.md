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

Minimal screen-capture and annotation app for macOS and Windows.

## Download

[Download the latest release](../../releases/latest)

- macOS: universal DMG, arm64 ZIP, or x64 ZIP
- Windows: portable EXE

> Windows may show a SmartScreen warning on first launch because releases are not yet signed.

## Features

- Capture a region, window, or display
- Annotate with shapes, arrows, text, highlight, and blur
- Undo, redo, zoom, and pan
- Save as PNG or copy to clipboard
- Optional Pro tools for scrolling capture and screen recording

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+S` | Capture screen |
| `Cmd/Ctrl+O` | Open image |
| `Cmd/Ctrl+E` | Export PNG |
| `Cmd/Ctrl+C` | Copy to clipboard |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |

## Development

```bash
npm install
npm start
npm run build
```

Built apps are generated in `dist/`.

## License

MIT
