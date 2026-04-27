"""pico – lightweight screen-capture & annotation tool (redesigned UI)."""

import math
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox, simpledialog

from PIL import Image, ImageDraw, ImageGrab, ImageTk

# ── Design tokens ────────────────────────────────────────────────────────────

FONT = "Segoe UI"

BG        = "#F7F8FA"
SURFACE   = "#FFFFFF"
CANVAS_BG = "#ECEEF2"
BORDER    = "#E2E5EA"
BORDER_LT = "#EEF0F4"
TEXT      = "#1A1D23"
TEXT_SEC  = "#6B7280"
TEXT_MUT  = "#A0A6B1"
ACCENT    = "#2563EB"
ACCENT_HV = "#1D4ED8"
ACCENT_BG = "#EBF2FF"
HOVER_BG  = "#F0F2F5"
PRESS_BG  = "#E4E7EC"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hover_bind(widget, normal_bg, hover_bg):
    """Bind enter/leave hover effect on *widget*."""
    widget.bind("<Enter>", lambda _e: widget.configure(bg=hover_bg))
    widget.bind("<Leave>", lambda _e: widget.configure(bg=normal_bg))


def _hover_unbind(widget, fixed_bg):
    """Remove hover and lock *widget* to *fixed_bg*."""
    widget.bind("<Enter>", lambda _e: None)
    widget.bind("<Leave>", lambda _e: None)
    widget.configure(bg=fixed_bg)


# ── Application ──────────────────────────────────────────────────────────────

class PicoApp:
    TOOL_LABELS = {
        "select": ("⊹", "Mover"),
        "rect":   ("□", "Rectángulo"),
        "arrow":  ("↗", "Flecha"),
        "text":   ("T", "Texto"),
    }

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("pico")
        self.root.geometry("1280x820")
        self.root.minsize(980, 620)
        self.root.configure(bg=BG)

        # ── State ────────────────────────────────────────────────────────
        self.image = None
        self.base_image = None
        self.tk_image = None
        self.draw_mode = "rect"
        self.start = None
        self.preview_id = None
        self.items = []
        self.font_size = 24
        self.stroke_width = 3
        self.current_color = ACCENT

        # ── Build ────────────────────────────────────────────────────────
        self._build_toolbar()
        self._build_canvas()
        self._build_status_bar()
        self._bind_canvas_events()
        self._bind_shortcuts()
        self.set_mode("rect")

    # ── Toolbar ──────────────────────────────────────────────────────────

    def _build_toolbar(self) -> None:
        # Toolbar frame – fixed 48 px
        bar = tk.Frame(self.root, bg=SURFACE, height=48)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        # 1) Action buttons ------------------------------------------------
        for label, cmd in [
            ("Capturar", self.capture_screen),
            ("Abrir",    self.open_image),
            ("Exportar", self.export_png),
        ]:
            b = tk.Button(
                bar, text=label, command=cmd,
                bg=SURFACE, fg=TEXT, activebackground=HOVER_BG, activeforeground=TEXT,
                relief="flat", bd=0, highlightthickness=0,
                padx=12, pady=4, font=(FONT, 10), cursor="hand2",
            )
            b.pack(side="left", padx=(8, 0), pady=8)
            _hover_bind(b, SURFACE, HOVER_BG)

        self._sep(bar)

        # 2) Tool buttons ---------------------------------------------------
        self.mode_buttons: dict[str, tk.Button] = {}
        for mode in ("select", "rect", "arrow", "text"):
            icon = self.TOOL_LABELS[mode][0]
            b = tk.Button(
                bar, text=icon, command=lambda m=mode: self.set_mode(m),
                bg=SURFACE, fg=TEXT_SEC, activebackground=HOVER_BG, activeforeground=TEXT_SEC,
                relief="flat", bd=0, highlightthickness=0,
                width=3, pady=4, font=(FONT, 12), cursor="hand2",
            )
            b.pack(side="left", padx=2, pady=8)
            self.mode_buttons[mode] = b

        self._sep(bar)

        # 3) Properties: color swatch + stroke width -----------------------
        self.color_swatch = tk.Canvas(
            bar, width=24, height=24, bg=SURFACE,
            highlightthickness=0, bd=0, cursor="hand2",
        )
        self.color_swatch.pack(side="left", padx=(8, 6), pady=12)
        self._draw_swatch()
        self.color_swatch.bind("<Button-1>", lambda _e: self.pick_color())

        tk.Label(
            bar, text="Grosor", bg=SURFACE, fg=TEXT_SEC, font=(FONT, 9),
        ).pack(side="left", padx=(4, 4))

        self.stroke_entry = tk.Entry(
            bar, width=3, justify="center",
            bg=HOVER_BG, fg=TEXT, font=(FONT, 10),
            relief="flat", bd=0,
            highlightthickness=1, highlightbackground=BORDER_LT, highlightcolor=ACCENT,
            insertbackground=TEXT,
        )
        self.stroke_entry.insert(0, str(self.stroke_width))
        self.stroke_entry.pack(side="left", padx=(0, 8), pady=12)
        self.stroke_entry.bind("<KeyRelease>", lambda _e: self._sync_stroke())
        self.stroke_entry.bind("<FocusOut>", lambda _e: self._sync_stroke())

        # 4) Hints (right-aligned) -----------------------------------------
        tk.Label(
            bar, text="R rect · A flecha · T texto · V mover",
            bg=SURFACE, fg=TEXT_MUT, font=(FONT, 9),
        ).pack(side="right", padx=12)

        # Bottom 1 px border line
        tk.Frame(self.root, bg=BORDER, height=1).pack(fill="x")

    def _sep(self, parent) -> None:
        """Insert a 1 px × 22 px vertical separator."""
        s = tk.Frame(parent, width=1, height=22, bg=BORDER)
        s.pack(side="left", padx=8, pady=13)

    def _draw_swatch(self) -> None:
        self.color_swatch.delete("all")
        self.color_swatch.create_oval(
            3, 3, 21, 21,
            fill=self.current_color, outline=BORDER, width=1,
        )

    # ── Canvas area ──────────────────────────────────────────────────────

    def _build_canvas(self) -> None:
        wrapper = tk.Frame(self.root, bg=BG)
        wrapper.pack(fill="both", expand=True, padx=10, pady=(8, 0))

        border_frame = tk.Frame(wrapper, bg=BORDER)
        border_frame.pack(fill="both", expand=True)

        self.canvas = tk.Canvas(
            border_frame, bg=CANVAS_BG,
            highlightthickness=0, bd=0, cursor="crosshair",
        )
        self.canvas.pack(fill="both", expand=True, padx=1, pady=1)

        # Empty-state hint (centered later via <Configure>)
        self._empty_id = self.canvas.create_text(
            0, 0,
            text="Pulsa 'Capturar' u 'Abrir' para comenzar",
            fill=TEXT_MUT, font=(FONT, 14), tags=("empty",),
        )
        self.canvas.bind("<Configure>", self._on_canvas_configure)

    def _on_canvas_configure(self, event) -> None:
        """Keep the empty-state text centred when the window resizes."""
        if self.canvas.find_withtag("empty"):
            self.canvas.coords("empty", event.width / 2, event.height / 2)
        if self.image is not None:
            self._render_image()

    # ── Status bar ───────────────────────────────────────────────────────

    def _build_status_bar(self) -> None:
        bar = tk.Frame(self.root, bg=BG, height=26)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        self.status_left = tk.Label(
            bar, text="", bg=BG, fg=TEXT_MUT, font=(FONT, 9), anchor="w",
        )
        self.status_left.pack(side="left", padx=12, pady=(4, 6))

        tk.Label(
            bar, text="pico v1", bg=BG, fg=TEXT_MUT, font=(FONT, 9), anchor="e",
        ).pack(side="right", padx=12, pady=(4, 6))

        self._update_status()

    def _update_status(self) -> None:
        tool_name = self.TOOL_LABELS.get(self.draw_mode, ("", ""))[1]
        if self.image:
            dims = f"{self.image.width}×{self.image.height}"
            self.status_left.configure(text=f"{tool_name} · {dims}")
        else:
            self.status_left.configure(text=tool_name)

    # ── Tool mode ────────────────────────────────────────────────────────

    def set_mode(self, mode: str) -> None:
        self.draw_mode = mode
        for m, btn in self.mode_buttons.items():
            if m == mode:
                btn.configure(bg=ACCENT_BG, fg=ACCENT,
                              activebackground=ACCENT_BG, activeforeground=ACCENT)
                _hover_unbind(btn, ACCENT_BG)
            else:
                btn.configure(bg=SURFACE, fg=TEXT_SEC,
                              activebackground=HOVER_BG, activeforeground=TEXT_SEC)
                _hover_bind(btn, SURFACE, HOVER_BG)

        cursors = {"select": "fleur", "text": "xterm"}
        self.canvas.configure(cursor=cursors.get(mode, "crosshair"))
        self._update_status()

    # ── Color & stroke ───────────────────────────────────────────────────

    def pick_color(self) -> None:
        color = colorchooser.askcolor(color=self.current_color, title="Elige un color")
        if color and color[1]:
            self.current_color = color[1]
            self._draw_swatch()

    def _sync_stroke(self) -> None:
        raw = self.stroke_entry.get().strip()
        try:
            val = int(raw)
            if val < 1:
                val = 1
            elif val > 20:
                val = 20
            self.stroke_width = val
        except ValueError:
            pass

    # ── Canvas events ────────────────────────────────────────────────────

    def _bind_canvas_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

    def _bind_shortcuts(self) -> None:
        self.root.bind("<Control-Shift-S>", lambda _e: self.capture_screen())
        self.root.bind("<Control-o>",       lambda _e: self.open_image())
        self.root.bind("<Control-e>",       lambda _e: self.export_png())
        self.root.bind("<F8>",              lambda _e: self.capture_screen())

        for key, mode in [("r", "rect"), ("a", "arrow"), ("t", "text"), ("v", "select")]:
            self.root.bind(
                f"<{key}>",
                lambda _e, m=mode: self.set_mode(m)
                    if self.root.focus_get() != self.stroke_entry else None,
            )

    # ── Image loading ────────────────────────────────────────────────────

    def capture_screen(self) -> None:
        self.root.withdraw()
        self.root.after(300, self._grab_screen)

    def _grab_screen(self) -> None:
        try:
            grabbed = ImageGrab.grab(all_screens=True)
        except Exception as exc:
            self.root.deiconify()
            messagebox.showerror("Error", f"No se pudo capturar la pantalla:\n{exc}")
            return
        self.root.deiconify()
        self.load_image(grabbed)

    def open_image(self) -> None:
        path = filedialog.askopenfilename(
            title="Abrir imagen",
            filetypes=[("Imagen", "*.png *.jpg *.jpeg *.bmp *.webp")],
        )
        if not path:
            return
        try:
            img = Image.open(path).convert("RGB")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo abrir la imagen:\n{exc}")
            return
        self.load_image(img)

    def load_image(self, pil_image: Image.Image) -> None:
        self.base_image = pil_image.copy()
        self.image = pil_image.copy()
        self.items.clear()
        self.canvas.delete("all")
        self._render_image()
        self._update_status()

    # ── Rendering ────────────────────────────────────────────────────────

    def _render_image(self) -> None:
        if self.image is None:
            return
        self.tk_image = ImageTk.PhotoImage(self.image)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self.tk_image, anchor="nw", tags=("background",))
        self.canvas.config(scrollregion=(0, 0, self.image.width, self.image.height))

        self.root.update_idletasks()
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        x = max((cw - self.image.width) // 2, 0)
        y = max((ch - self.image.height) // 2, 0)
        self.canvas.move("background", x, y)

        for item in self.items:
            self._draw_item_on_canvas(item, offset=(x, y))

    def _draw_item_on_canvas(self, item, offset=(0, 0)):
        ox, oy = offset
        kind = item["type"]
        if kind == "rect":
            x1, y1, x2, y2 = item["coords"]
            self.canvas.create_rectangle(
                x1 + ox, y1 + oy, x2 + ox, y2 + oy,
                outline=item["color"], width=item["width"],
            )
        elif kind == "arrow":
            x1, y1, x2, y2 = item["coords"]
            self.canvas.create_line(
                x1 + ox, y1 + oy, x2 + ox, y2 + oy,
                fill=item["color"], width=item["width"],
                arrow=tk.LAST, arrowshape=(18, 22, 7), capstyle=tk.ROUND,
            )
        elif kind == "text":
            x, y = item["coords"]
            self.canvas.create_text(
                x + ox, y + oy,
                text=item["text"], fill=item["color"],
                font=(FONT, self.font_size, "bold"), anchor="nw",
            )

    def _canvas_offset(self):
        if self.image is None:
            return 0, 0
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        return max((cw - self.image.width) // 2, 0), max((ch - self.image.height) // 2, 0)

    def _to_image_coords(self, x: int, y: int):
        if self.image is None:
            return x, y
        ox, oy = self._canvas_offset()
        return x - ox, y - oy

    def _clamp_point(self, x: int, y: int):
        if self.image is None:
            return x, y
        return max(0, min(x, self.image.width)), max(0, min(y, self.image.height))

    # ── Drawing interactions ─────────────────────────────────────────────

    def on_press(self, event):
        if self.image is None:
            return
        ix, iy = self._to_image_coords(event.x, event.y)
        if not (0 <= ix <= self.image.width and 0 <= iy <= self.image.height):
            return

        self.start = (ix, iy)
        if self.draw_mode == "text":
            text = simpledialog.askstring("Texto", "Escribe el texto:", parent=self.root)
            if text:
                self.items.append({
                    "type": "text", "coords": (ix, iy),
                    "text": text, "color": self.current_color,
                })
                self._compose_image()
            self.start = None

    def on_drag(self, event):
        if self.image is None or self.start is None:
            return
        if self.draw_mode not in {"rect", "arrow"}:
            return

        if self.preview_id:
            self.canvas.delete(self.preview_id)
            self.preview_id = None

        x1, y1 = self.start
        x2, y2 = self._to_image_coords(event.x, event.y)
        x2, y2 = self._clamp_point(x2, y2)
        ox, oy = self._canvas_offset()

        if self.draw_mode == "rect":
            self.preview_id = self.canvas.create_rectangle(
                x1 + ox, y1 + oy, x2 + ox, y2 + oy,
                outline=self.current_color, width=self.stroke_width, dash=(7, 5),
            )
        elif self.draw_mode == "arrow":
            self.preview_id = self.canvas.create_line(
                x1 + ox, y1 + oy, x2 + ox, y2 + oy,
                fill=self.current_color, width=self.stroke_width,
                arrow=tk.LAST, arrowshape=(18, 22, 7),
                capstyle=tk.ROUND, smooth=True, dash=(10, 6),
            )

    def on_release(self, event):
        if self.image is None or self.start is None:
            return
        if self.draw_mode not in {"rect", "arrow"}:
            self.start = None
            return

        x1, y1 = self.start
        x2, y2 = self._to_image_coords(event.x, event.y)
        x2, y2 = self._clamp_point(x2, y2)

        if self.preview_id:
            self.canvas.delete(self.preview_id)
            self.preview_id = None

        if abs(x2 - x1) < 4 and abs(y2 - y1) < 4:
            self.start = None
            return

        if self.draw_mode == "rect":
            x1, x2 = sorted([x1, x2])
            y1, y2 = sorted([y1, y2])

        self.items.append({
            "type": self.draw_mode,
            "coords": (x1, y1, x2, y2),
            "color": self.current_color,
            "width": self.stroke_width,
        })
        self._compose_image()
        self.start = None

    # ── Compositing (PIL) ────────────────────────────────────────────────

    def _compose_image(self):
        if self.base_image is None:
            return

        out = self.base_image.copy()
        draw = ImageDraw.Draw(out)

        for item in self.items:
            kind = item["type"]
            if kind == "rect":
                x1, y1, x2, y2 = item["coords"]
                draw.rectangle((x1, y1, x2, y2), outline=item["color"], width=item["width"])
            elif kind == "arrow":
                x1, y1, x2, y2 = item["coords"]
                draw.line((x1, y1, x2, y2), fill=item["color"], width=item["width"])
                self._draw_arrow_head(draw, x1, y1, x2, y2, color=item["color"], size=22)
            elif kind == "text":
                x, y = item["coords"]
                draw.text((x, y), item["text"], fill=item["color"])

        self.image = out
        self._render_image()

    def _draw_arrow_head(self, draw, x1, y1, x2, y2, color, size=16):
        angle = math.atan2(y2 - y1, x2 - x1)
        left  = (x2 - size * math.cos(angle - math.pi / 7),
                  y2 - size * math.sin(angle - math.pi / 7))
        right = (x2 - size * math.cos(angle + math.pi / 7),
                  y2 - size * math.sin(angle + math.pi / 7))
        draw.polygon([(x2, y2), left, right], fill=color)

    # ── Export ───────────────────────────────────────────────────────────

    def export_png(self) -> None:
        if self.image is None:
            messagebox.showinfo("Sin imagen", "Primero captura o abre una imagen.")
            return

        path = filedialog.asksaveasfilename(
            title="Exportar PNG",
            defaultextension=".png",
            filetypes=[("PNG", "*.png")],
            initialfile="captura_anotada.png",
        )
        if not path:
            return

        try:
            self.image.save(path, "PNG")
        except Exception as exc:
            messagebox.showerror("Error", f"No se pudo exportar:\n{exc}")
            return
        messagebox.showinfo("Listo", f"Imagen exportada en:\n{path}")


# ── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    root = tk.Tk()
    PicoApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
