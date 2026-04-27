# pico

App de escritorio minimalista (estilo Apple) para **capturar pantalla y anotar** con cuadrados, flechas y texto, pensada para compartir rápidamente con otros usuarios.

## Características

- Captura de pantalla completa (Windows).
- Apertura de imágenes existentes (PNG/JPG/BMP/WEBP).
- Herramientas de anotación simples:
  - ▢ (cuadrado)
  - ➜ (flecha)
  - T (texto)
- Exportación rápida a PNG.
- Interfaz limpia y minimalista inspirada en diseño moderno.
- Landing estática (`index.html`) para publicar la descarga de `pico.exe` desde el último release.

## Requisitos

- Python 3.10+
- Windows 10/11

Instala dependencias:

```bash
pip install -r requirements.txt
```

## Ejecutar en desarrollo

```bash
python app.py
```

## Crear ejecutable portable para Windows

Se incluye un script para generar un `.exe` portable con PyInstaller:

```bat
build_windows.bat
```

El ejecutable se genera en:

- `dist\pico.exe`

## Landing para descarga del EXE

La landing principal ahora está en `index.html` (GitHub Pages la sirve por defecto).

El botón de descarga se autoconfigura para apuntar al último release:

- `https://github.com/<owner>/<repo>/releases/latest/download/pico.exe`

Notas:
- En GitHub Pages detecta `owner/repo` automáticamente por URL.
- Fuera de GitHub Pages, define `data-github-owner` y `data-github-repo` en `<body>` para activar el enlace.

## Flujo de uso

1. Pulsa **Capturar pantalla** o **Abrir imagen**.
2. Elige herramienta: **▢**, **➜** o **T**.
3. Dibuja/anota sobre la captura.
4. Pulsa **Exportar PNG** y comparte.


## ¿Se puede generar el portable directamente?

Sí, pero **el `.exe` de Windows debe compilarse en Windows**.

- En local (Windows): ejecuta `build_windows.bat`.
- Desde cualquier SO: usa el workflow de GitHub Actions **Build Windows Portable**.
  Se ejecuta manualmente (`workflow_dispatch`) y también en `push` a `main` / `pull_request` cuando cambian archivos del proyecto.
  Al terminar, descarga el artefacto `pico-windows-portable` que contiene `pico.exe`.
