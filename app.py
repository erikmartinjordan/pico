import math
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog

from PIL import Image, ImageDraw, ImageGrab, ImageTk


BG = "#F4F5F7"
PANEL = "#FFFFFF"
ACCENT = "#007AFF"
TEXT = "#1D1D1F"
MUTED = "#6E6E73"


class PicoApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("pico")
        self.root.geometry("1280x820")
        self.root.minsize(980, 620)
        self.root.configure(bg=BG)

        self.image = None
        self.base_image = None
        self.tk_image = None
        self.draw_mode = "select"
        self.start = None
        self.preview_id = None
        self.items = []
        self.font_size = 24
        self.stroke_width = 6

        self._build_ui()
        self._bind_canvas_events()

    def _build_ui(self) -> None:
        top = tk.Frame(self.root, bg=BG)
        top.pack(fill="x", padx=18, pady=(18, 10))

        title = tk.Label(top, text="pico", font=("Segoe UI", 22, "bold"), fg=TEXT, bg=BG)
        title.pack(side="left")

        subtitle = tk.Label(
            top,
            text="Captura y comparte ideas en segundos",
            font=("Segoe UI", 11),
            fg=MUTED,
            bg=BG,
        )
        subtitle.pack(side="left", padx=10, pady=(8, 0))

        toolbar = tk.Frame(self.root, bg=PANEL, bd=0, highlightthickness=0)
        toolbar.pack(fill="x", padx=18, pady=(0, 10))

        self._button(toolbar, "Capturar pantalla", self.capture_screen).pack(side="left", padx=8, pady=8)
        self._button(toolbar, "Abrir imagen", self.open_image).pack(side="left", padx=8, pady=8)

        sep = tk.Frame(toolbar, width=1, height=34, bg="#E6E7EB")
        sep.pack(side="left", padx=10)

        self.mode_buttons = {}
        for mode, label in [
            ("select", "Mover"),
            ("rect", "▢"),
            ("arrow", "➜"),
            ("text", "T"),
        ]:
            b = self._button(toolbar, label, lambda m=mode: self.set_mode(m), is_tool=True)
            b.pack(side="left", padx=6, pady=8)
            self.mode_buttons[mode] = b

        sep2 = tk.Frame(toolbar, width=1, height=34, bg="#E6E7EB")
        sep2.pack(side="left", padx=10)

        self._button(toolbar, "Exportar PNG", self.export_png).pack(side="left", padx=8, pady=8)

        right = tk.Frame(toolbar, bg=PANEL)
        right.pack(side="right", padx=10)
        tk.Label(right, text="Tip: arrastra para dibujar", bg=PANEL, fg=MUTED, font=("Segoe UI", 10)).pack()

        canvas_wrap = tk.Frame(self.root, bg=BG)
        canvas_wrap.pack(fill="both", expand=True, padx=18, pady=(0, 18))

        self.canvas = tk.Canvas(
            canvas_wrap,
            bg="#EAECF0",
            highlightthickness=0,
            bd=0,
            cursor="cross",
        )
        self.canvas.pack(fill="both", expand=True)

        self.canvas.create_text(
            640,
            370,
            text="Pulsa ‘Capturar pantalla’ u ‘Abrir imagen’ para comenzar",
            fill=MUTED,
            font=("Segoe UI", 15),
            tags=("empty",),
        )

        self.set_mode("rect")

    def _button(self, parent, text, command, is_tool=False):
        b = tk.Button(
            parent,
            text=text,
            command=command,
            bg="#FFFFFF",
            fg=TEXT,
            activebackground="#F2F2F7",
            activeforeground=TEXT,
            relief="flat",
            bd=0,
            padx=14,
            pady=8,
            font=("Segoe UI", 10, "bold" if is_tool else "normal"),
            cursor="hand2",
        )
        return b

    def _bind_canvas_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

    def set_mode(self, mode: str) -> None:
        self.draw_mode = mode
        for m, button in self.mode_buttons.items():
            button.configure(bg="#EAF2FF" if m == mode else "#FFFFFF", fg=ACCENT if m == mode else TEXT)
        if mode == "select":
            self.canvas.configure(cursor="fleur")
        elif mode == "text":
            self.canvas.configure(cursor="xterm")
        else:
            self.canvas.configure(cursor="cross")

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
            self.canvas.create_rectangle(x1 + ox, y1 + oy, x2 + ox, y2 + oy, outline=ACCENT, width=4)
        elif kind == "arrow":
            x1, y1, x2, y2 = item["coords"]
            self.canvas.create_line(
                x1 + ox,
                y1 + oy,
                x2 + ox,
                y2 + oy,
                fill=ACCENT,
                width=5,
                arrow=tk.LAST,
                arrowshape=(18, 22, 7),
                capstyle=tk.ROUND,
            )
        elif kind == "text":
            x, y = item["coords"]
            self.canvas.create_text(x + ox, y + oy, text=item["text"], fill=ACCENT, font=("Segoe UI", self.font_size, "bold"), anchor="nw")

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

    def _square_from_points(self, x1: int, y1: int, x2: int, y2: int):
        dx = x2 - x1
        dy = y2 - y1
        side = min(max(abs(dx), abs(dy)), min(self.image.width, self.image.height))
        sx = 1 if dx >= 0 else -1
        sy = 1 if dy >= 0 else -1
        nx2 = x1 + (side * sx)
        ny2 = y1 + (side * sy)
        nx2, ny2 = self._clamp_point(nx2, ny2)
        return x1, y1, nx2, ny2

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
                self.items.append({"type": "text", "coords": (ix, iy), "text": text})
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
            x1, y1, x2, y2 = self._square_from_points(x1, y1, x2, y2)
            self.preview_id = self.canvas.create_rectangle(
                x1 + ox, y1 + oy, x2 + ox, y2 + oy, outline=ACCENT, width=4, dash=(7, 5)
            )
        elif self.draw_mode == "arrow":
            self.preview_id = self.canvas.create_line(
                x1 + ox,
                y1 + oy,
                x2 + ox,
                y2 + oy,
                fill=ACCENT,
                width=5,
                arrow=tk.LAST,
                arrowshape=(18, 22, 7),
                capstyle=tk.ROUND,
                smooth=True,
                dash=(10, 6),
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
            x1, y1, x2, y2 = self._square_from_points(x1, y1, x2, y2)
            x1, x2 = sorted([x1, x2])
            y1, y2 = sorted([y1, y2])

        self.items.append({"type": self.draw_mode, "coords": (x1, y1, x2, y2)})
        self._compose_image()
        self.start = None

    def _compose_image(self):
        if self.base_image is None:
            return

        out = self.base_image.copy()
        draw = ImageDraw.Draw(out)

        for item in self.items:
            kind = item["type"]
            if kind == "rect":
                x1, y1, x2, y2 = item["coords"]
                draw.rectangle((x1, y1, x2, y2), outline=ACCENT, width=self.stroke_width)
            elif kind == "arrow":
                x1, y1, x2, y2 = item["coords"]
                draw.line((x1, y1, x2, y2), fill=ACCENT, width=self.stroke_width)
                self._draw_arrow_head(draw, x1, y1, x2, y2, size=22)
            elif kind == "text":
                x, y = item["coords"]
                draw.text((x, y), item["text"], fill=ACCENT)

        self.image = out
        self._render_image()

    def _draw_arrow_head(self, draw, x1, y1, x2, y2, size=16):
        angle = math.atan2(y2 - y1, x2 - x1)
        left = (x2 - size * math.cos(angle - math.pi / 7), y2 - size * math.sin(angle - math.pi / 7))
        right = (x2 - size * math.cos(angle + math.pi / 7), y2 - size * math.sin(angle + math.pi / 7))
        draw.polygon([(x2, y2), left, right], fill=ACCENT)

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


def main() -> None:
    root = tk.Tk()
    app = PicoApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
