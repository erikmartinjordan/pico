# pico

Lightweight screen-capture & annotation app for Windows. One portable `.exe`, no installation, no dependencies.

## What it does

Capture your screen or open any image, annotate it with rectangles, arrows and text, then export to PNG. That's it.

## Features

- **Full-screen capture** — grab all monitors instantly (`Ctrl+Shift+S` or `F8`)
- **Annotation tools** — rectangle, arrow and text overlays with customizable color and stroke
- **Open any image** — PNG, JPG, BMP, WEBP (`Ctrl+O`)
- **Export to PNG** — save the annotated result anywhere (`Ctrl+E`)
- **Portable** — single `pico.exe`, runs from USB, desktop, wherever
- **Minimal UI** — unified toolbar, hover states, status bar, keyboard shortcuts

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+S` / `F8` | Capture screen |
| `Ctrl+O` | Open image |
| `Ctrl+E` | Export PNG |
| `R` | Rectangle tool |
| `A` | Arrow tool |
| `T` | Text tool |
| `V` | Move / select |

## Requirements

- Python 3.10+
- Windows 10 / 11

```bash
pip install -r requirements.txt
```

Only dependency: `Pillow >= 10.4.0`.

## Run from source

```bash
python app.py
```

## Build portable EXE

### Locally (Windows)

```bat
build_windows.bat
```

Produces `dist\pico.exe`.

### Via GitHub Actions

The **Build Windows Portable** workflow runs automatically on:

- Push to `main` (when `.py`, `requirements.txt`, `build_windows.bat` or the workflow itself change)
- Pull requests touching those files
- Manual trigger (`workflow_dispatch`)
- Release publish — attaches `pico.exe` as a release asset

Download the artifact `pico-windows-portable` from the workflow run, or grab `pico.exe` from the latest release.

## Download

Grab the latest portable EXE from [Releases](../../releases/latest/download/pico.exe).

The landing page (`index.html`) auto-detects `owner/repo` on GitHub Pages and points the download button to the latest release.

## Project structure

```
pico/
├── app.py                        # Main application (tkinter + Pillow)
├── index.html                    # Landing page for GitHub Pages
├── requirements.txt              # Python dependencies
├── build_windows.bat             # Local PyInstaller build script
└── .github/workflows/
    └── build-windows-portable.yml  # CI: build, artifact, release upload
```

## Design

The UI follows a minimal, neutral-cool palette inspired by Windows 11 and Linear:

| Token | Hex | Role |
| --- | --- | --- |
| `BG` | `#F7F8FA` | App background |
| `SURFACE` | `#FFFFFF` | Toolbar, panels |
| `ACCENT` | `#2563EB` | Active tool, links |
| `TEXT` | `#1A1D23` | Primary text |
| `TEXT_SEC` | `#6B7280` | Labels, inactive |
| `TEXT_MUT` | `#A0A6B1` | Hints, status bar |

Typography: Segoe UI at 9–14 px. Spacing on an 8 px grid.

## License

MIT
