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

PALETTE = [
    "#EF4444",  # Red
    "#F97316",  # Orange
    "#EAB308",  # Yellow
    "#22C55E",  # Green
    "#2563EB",  # Blue
    "#8B5CF6",  # Purple
    "#EC4899",  # Pink
    "#1A1D23",  # Dark
    "#FFFFFF",  # White
]

STROKES = [2, 4, 7, 12]


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
        "select": ("\u22c9", "Mover"),
        "rect":   ("\u25a1", "Rect\u00e1ngulo"),
        "arrow":  ("\u2197", "Flecha"),
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
        self.stroke_width = 4
        self.current_color = ACCENT

        # Region capture state
        self._full_grab = None
        self._overlay = None
        self._overlay_img = None
        self._overlay_canvas = None
        self._region_start = None
        self._region_rect_id = None
        self._region_preview_tk = None

        # ── Build ────────────────────────────────────────────────────────
        self._build_toolbar()
        self._build_canvas()
        self._build_status_bar()
        self._bind_canvas_events()
        self._bind_shortcuts()
        self.set_mode("rect")

    # ── Toolbar ──────────────────────────────────────────────────────────

    def _build_toolbar(self) -> None:
        bar = tk.Frame(self.root, bg=SURFACE, height=52)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        # 1) Action buttons ------------------------------------------------
        for label, cmd in [
            ("Capturar", self.capture_region),
            ("Abrir",    self.open_image),
            ("Exportar", self.export_png),
        ]:
            b = tk.Button(
                bar, text=label, command=cmd,
                bg=SURFACE, fg=TEXT, activebackground=HOVER_BG, activeforeground=TEXT,
                relief="flat", bd=0, highlightthickness=0,
                padx=12, pady=4, font=(FONT, 10), cursor="hand2",
            )
            b.pack(side="left", padx=(8, 0), pady=10)
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
            b.pack(side="left", padx=2, pady=10)
            self.mode_buttons[mode] = b

        self._sep(bar)

        # 3) Color palette --------------------------------------------------
        palette_frame = tk.Frame(bar, bg=SURFACE)
        palette_frame.pack(side="left", padx=(4, 0), pady=10)

        self.color_swatches = []
        for color in PALETTE:
            sw = tk.Canvas(
                palette_frame, width=18, height=18, bg=SURFACE,
                highlightthickness=0, bd=0, cursor="hand2",
            )
            sw.pack(side="left", padx=1)
            sw._color = color
            self._draw_palette_dot(sw, color, selected=(color == self.current_color))
            sw.bind("<Button-1>", lambda _e, c=color: self._select_color(c))
            self.color_swatches.append(sw)

        # Custom color (+)
        plus = tk.Canvas(
            palette_frame, width=18, height=18, bg=SURFACE,
            highlightthickness=0, bd=0, cursor="hand2",
        )
        plus.pack(side="left", padx=(3, 0))
        plus.create_oval(2, 2, 16, 16, fill=HOVER_BG, outline=BORDER, width=1)
        plus.create_line(6, 9, 12, 9, fill=TEXT_SEC, width=1.5)
        plus.create_line(9, 6, 9, 12, fill=TEXT_SEC, width=1.5)
        plus.bind("<Button-1>", lambda _e: self._pick_custom_color())

        self._sep(bar)

        # 4) Stroke width selector ------------------------------------------
        stroke_frame = tk.Frame(bar, bg=SURFACE)
        stroke_frame.pack(side="left", padx=(4, 0), pady=10)

        self.stroke_buttons = []
        for w in STROKES:
            sw = tk.Canvas(
                stroke_frame, width=26, height=26, bg=SURFACE,
                highlightthickness=0, bd=0, cursor="hand2",
            )
            sw.pack(side="left", padx=1)
            sw._stroke_w = w
            self._draw_stroke_icon(sw, w, selected=(w == self.stroke_width))
            sw.bind("<Button-1>", lambda _e, ww=w: self._select_stroke(ww))
            self.stroke_buttons.append(sw)

        self._sep(bar)

        # 5) Undo button ----------------------------------------------------
        undo = tk.Button(
            bar, text="\u21a9", command=self.undo,
            bg=SURFACE, fg=TEXT_SEC, activebackground=HOVER_BG, activeforeground=TEXT_SEC,
            relief="flat", bd=0, highlightthickness=0,
            width=3, pady=4, font=(FONT, 12), cursor="hand2",
        )
        undo.pack(side="left", padx=2, pady=10)
        _hover_bind(undo, SURFACE, HOVER_BG)

        # 6) Hints (right) -------------------------------------------------
        tk.Label(
            bar, text="R rect \u00b7 A flecha \u00b7 T texto \u00b7 V mover \u00b7 \u2303Z deshacer",
            bg=SURFACE, fg=TEXT_MUT, font=(FONT, 9),
        ).pack(side="right", padx=12)

        # Bottom border
        tk.Frame(self.root, bg=BORDER, height=1).pack(fill="x")

    # ── Toolbar widget helpers ───────────────────────────────────────────

    def _sep(self, parent) -> None:
        tk.Frame(parent, width=1, height=24, bg=BORDER).pack(
            side="left", padx=8, pady=14,
        )

    def _draw_palette_dot(self, canvas, color, selected=False):
        canvas.delete("all")
        if selected:
            canvas.create_oval(0, 0, 17, 17, outline=ACCENT, width=2, fill="")
            canvas.create_oval(4, 4, 13, 13, fill=color, outline="")
        else:
            ol = BORDER if color == "#FFFFFF" else ""
            canvas.create_oval(2, 2, 15, 15, fill=color, outline=ol, width=1)

    def _draw_stroke_icon(self, canvas, width, selected=False):
        canvas.delete("all")
        bg = ACCENT_BG if selected else SURFACE
        fg = ACCENT if selected else TEXT_SEC
        canvas.configure(bg=bg)
        vis = max(1, min(width, 10))
        canvas.create_line(5, 13, 21, 13, fill=fg, width=vis, capstyle=tk.ROUND)

    def _select_color(self, color):
        self.current_color = color
        for sw in self.color_swatches:
            self._draw_palette_dot(sw, sw._color, selected=(sw._color == color))

    def _pick_custom_color(self):
        result = colorchooser.askcolor(color=self.current_color, title="Elige un color")
        if result and result[1]:
            self.current_color = result[1]
            # Deselect all palette dots
            for sw in self.color_swatches:
                self._draw_palette_dot(sw, sw._color, selected=False)

    def _select_stroke(self, width):
        self.stroke_width = width
        for sw in self.stroke_buttons:
            self._draw_stroke_icon(sw, sw._stroke_w, selected=(sw._stroke_w == width))

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

        self._empty_id = self.canvas.create_text(
            0, 0,
            text="Pulsa 'Capturar' u 'Abrir' para comenzar",
            fill=TEXT_MUT, font=(FONT, 14), tags=("empty",),
        )
        self.canvas.bind("<Configure>", self._on_canvas_configure)

    def _on_canvas_configure(self, event) -> None:
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
        parts = [tool_name]
        if self.image:
            parts.append(f"{self.image.width}\u00d7{self.image.height}")
        if self.items:
            parts.append(f"{len(self.items)} anotaci\u00f3n{'es' if len(self.items) != 1 else ''}")
        self.status_left.configure(text=" \u00b7 ".join(parts))

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

    # ── Undo ─────────────────────────────────────────────────────────────

    def undo(self) -> None:
        if not self.items:
            return
        self.items.pop()
        if self.base_image:
            self._compose_image()
        self._update_status()

    # ── Canvas events ────────────────────────────────────────────────────

    def _bind_canvas_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

    def _bind_shortcuts(self) -> None:
        self.root.bind("<Control-Shift-S>", lambda _e: self.capture_region())
        self.root.bind("<Control-o>",       lambda _e: self.open_image())
        self.root.bind("<Control-e>",       lambda _e: self.export_png())
        self.root.bind("<Control-z>",       lambda _e: self.undo())
        self.root.bind("<F8>",              lambda _e: self.capture_region())
        self.root.bind("<r>", lambda _e: self.set_mode("rect"))
        self.root.bind("<a>", lambda _e: self.set_mode("arrow"))
        self.root.bind("<t>", lambda _e: self.set_mode("text"))
        self.root.bind("<v>", lambda _e: self.set_mode("select"))

    # ── Region capture ───────────────────────────────────────────────────

    def capture_region(self) -> None:
        self.root.withdraw()
        self.root.after(350, self._start_region_select)

    def _start_region_select(self) -> None:
        try:
            self._full_grab = ImageGrab.grab(all_screens=False)
        except Exception as exc:
            self.root.deiconify()
            messagebox.showerror("Error", f"No se pudo capturar:\n{exc}")
            return

        self._overlay = tk.Toplevel(self.root)
        self._overlay.overrideredirect(True)
        self._overlay.attributes("-topmost", True)

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self._overlay.geometry(f"{sw}x{sh}+0+0")

        # Darkened background
        tinted = self._full_grab.copy().convert("RGBA")
        dark = Image.new("RGBA", tinted.size, (0, 0, 0, 120))
        tinted = Image.alpha_composite(tinted, dark).convert("RGB")
        self._overlay_img = ImageTk.PhotoImage(tinted)

        self._overlay_canvas = tk.Canvas(
            self._overlay, highlightthickness=0, bd=0, cursor="crosshair",
        )
        self._overlay_canvas.pack(fill="both", expand=True)
        self._overlay_canvas.create_image(
            0, 0, image=self._overlay_img, anchor="nw", tags="bg",
        )

        # Hint text
        self._overlay_canvas.create_text(
            sw // 2, 40,
            text="Arrastra para seleccionar zona \u00b7 Esc para cancelar",
            fill="white", font=(FONT, 12), tags="hint",
        )

        self._region_start = None
        self._region_rect_id = None
        self._region_preview_tk = None

        self._overlay_canvas.bind("<ButtonPress-1>", self._on_region_press)
        self._overlay_canvas.bind("<B1-Motion>", self._on_region_drag)
        self._overlay_canvas.bind("<ButtonRelease-1>", self._on_region_release)
        self._overlay.bind("<Escape>", self._on_region_cancel)

    def _on_region_press(self, event):
        self._region_start = (event.x, event.y)

    def _on_region_drag(self, event):
        if self._region_start is None:
            return

        x1, y1 = self._region_start
        x2, y2 = event.x, event.y
        rx1, ry1 = min(x1, x2), min(y1, y2)
        rx2, ry2 = max(x1, x2), max(y1, y2)

        # Clean previous
        self._overlay_canvas.delete("sel_bright")
        self._overlay_canvas.delete("sel_rect")
        self._overlay_canvas.delete("sel_dims")

        # Bright preview of selected region
        if rx2 - rx1 > 4 and ry2 - ry1 > 4:
            region = self._full_grab.crop((rx1, ry1, rx2, ry2))
            self._region_preview_tk = ImageTk.PhotoImage(region)
            self._overlay_canvas.create_image(
                rx1, ry1, image=self._region_preview_tk, anchor="nw", tags="sel_bright",
            )

        # Selection border
        self._overlay_canvas.create_rectangle(
            x1, y1, x2, y2, outline="white", width=1, tags="sel_rect",
        )

        # Dimensions label
        w_px, h_px = abs(x2 - x1), abs(y2 - y1)
        if w_px > 30 and h_px > 20:
            self._overlay_canvas.create_text(
                rx1 + 6, ry1 - 8,
                text=f"{w_px}\u00d7{h_px}", fill="white",
                font=(FONT, 9), anchor="sw", tags="sel_dims",
            )

    def _on_region_release(self, event):
        if self._region_start is None:
            self._cleanup_overlay()
            return

        x1, y1 = self._region_start
        x2, y2 = event.x, event.y
        rx1, ry1 = min(x1, x2), min(y1, y2)
        rx2, ry2 = max(x1, x2), max(y1, y2)

        grab = self._full_grab
        self._cleanup_overlay()

        if rx2 - rx1 > 10 and ry2 - ry1 > 10 and grab:
            cropped = grab.crop((rx1, ry1, rx2, ry2))
            self.load_image(cropped)

    def _on_region_cancel(self, _event):
        self._cleanup_overlay()

    def _cleanup_overlay(self):
        if self._overlay:
            self._overlay.destroy()
        self._overlay = None
        self._overlay_img = None
        self._overlay_canvas = None
        self._full_grab = None
        self._region_start = None
        self._region_rect_id = None
        self._region_preview_tk = None
        self.root.deiconify()

    # ── Open / load ──────────────────────────────────────────────────────

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
                self._update_status()
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
        self._update_status()
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
