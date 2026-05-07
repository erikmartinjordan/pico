# App icons

This directory is the canonical source for pico runtime icons.

- `icon.png` is the source icon used for generated app assets.
- `macos/` contains macOS PNG sizes and `icon.icns`.
- `windows/` contains Windows PNG sizes and `icon.ico`.
- `linux/icons/` contains Linux PNG sizes.

Electron Builder reads packaging icons from the repository-level `build/`
directory, while app windows use the generated icons in this folder at runtime.
