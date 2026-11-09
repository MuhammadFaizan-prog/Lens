"""Synthetic scene for the recorder e2e test: a full-screen window with a moving bar (so every frame
changes) that flashes a magenta square where the mouse goes down and logs the press (epoch ms, x, y).
Usage: python3 scene.py <width> <height> <log.jsonl>"""
import json
import sys
import time
import tkinter as tk

W, H, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
root = tk.Tk()
root.overrideredirect(True)
root.geometry(f"{W}x{H}+0+0")
c = tk.Canvas(root, width=W, height=H, bg="#20242c", highlightthickness=0)
c.pack()
for i in range(0, W, 80):
    c.create_line(i, 0, i, H, fill="#2c313b")
for j in range(0, H, 80):
    c.create_line(0, j, W, j, fill="#2c313b")
bar = c.create_rectangle(0, H - 40, 120, H - 10, fill="#3fa7ff", outline="")
log = open(LOG, "a", buffering=1)
x0 = [0]


def tick():
    x0[0] = (x0[0] + 8) % W
    c.coords(bar, x0[0], H - 40, x0[0] + 120, H - 10)
    root.after(33, tick)


def press(e):
    t = time.time() * 1000
    r = c.create_rectangle(e.x - 24, e.y - 24, e.x + 24, e.y + 24, fill="#ff00ff", outline="")
    root.after(700, lambda: c.delete(r))
    log.write(json.dumps({"t": t, "x": e.x_root, "y": e.y_root}) + "\n")


c.bind("<ButtonPress-1>", press)
root.after(33, tick)
root.mainloop()
