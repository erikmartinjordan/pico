# Bundled Pro media binaries

Place platform-specific executable binaries here for local development builds:

- `ffmpeg` / `ffmpeg.exe`
- `gifski` / `gifski.exe`

Electron Builder copies this directory to packaged app resources as `bin/` so
Pro recording conversion can resolve the bundled executables at runtime.
