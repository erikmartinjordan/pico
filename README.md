# Orange Fuji

<p align="center">
  <img src="src/assets/icons/macos/256x256.png" alt="Orange Fuji icon" width="128" height="128" />
</p>

<p align="center">
  <strong>Capture, annotate, share.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/downloads/erikmartinjordan/orange-fuji/total?label=Total%20downloads&style=flat-square" alt="Total downloads" />
</p>

Orange Fuji is a minimal screen capture and annotation app for Windows, Linux, and experimental macOS builds.

## Download

[Download the latest release](../../releases/latest)

Recommended launch targets:

- Windows: portable EXE
- Linux: AppImage
- macOS: experimental ad-hoc signed, unnotarized DMG/ZIP for technical users only

> Windows may show a SmartScreen warning on first launch because releases are not yet signed.
>
> macOS builds are ad-hoc signed, but they are not Developer ID signed or notarized until Orange Fuji can fund an Apple Developer Program account. Recent macOS versions can block unnotarized apps, require manual approval in System Settings, and ask for Screen Recording permission again after installs or updates because the app does not yet have a stable Developer ID identity. If you are not comfortable with that security tradeoff, use the Windows/Linux builds or build Orange Fuji from source on a Mac you control.

### macOS status

The native macOS app is not the primary launch target right now. It is useful for testing, but it has two known limitations:

1. Gatekeeper can make unnotarized apps difficult or impossible for mainstream users to open.
2. Screen capture requires Screen Recording permission in System Settings → Privacy & Security → Screen & System Audio Recording. Without Developer ID signing and notarization, macOS can treat updated builds as a new app and ask for this permission again. Orange Fuji detects denied permission and opens the correct settings pane with recovery instructions.

If you test the macOS build, download it only from the official GitHub release, verify checksums when provided, and expect to quit and reopen Orange Fuji after changing Screen Recording permission.

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

Orange Fuji uses Release Please with Conventional Commits for all official GitHub Releases. Pushes to `main` can build and upload CI artifacts, but they do not create official releases.

Use Conventional Commits for changes:

- `feat: add region presets`
- `fix: handle denied screen recording permission`
- `docs: update installation notes`
- `refactor: simplify capture state`

After commits are merged to `main`, Release Please opens or updates a release PR containing the next version bump and `CHANGELOG.md` changes. Merge that Release Please PR only when you are ready to publish officially; merging it creates the Git tag, GitHub Release, changelog update, and package version update. The release workflow then builds the desktop binaries and attaches them to that GitHub Release.

Orange Fuji's no-budget launch path is to treat Windows and Linux as the primary downloadable platforms while keeping macOS transparent and experimental until notarization is affordable.

Before publishing a release:

- Build Windows portable EXE and Linux AppImage as the main artifacts.
- Publish SHA-256 checksums for every artifact.
- Label macOS artifacts as ad-hoc signed and unnotarized.
- Keep the GitHub release page as the only official binary download source.
- Fund Apple Developer Program membership before marketing macOS as a polished one-click app.

## License

MIT
