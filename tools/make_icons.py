#!/usr/bin/env python3
"""Generate simple solid PNG icons for the extension without any imaging dependency."""
import struct, zlib, os, sys

def png(size, rgb=(34, 197, 94)):
    raw = b""
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            # rounded-square mask with a lighter "A" diagonal stripe
            cx, cy = x - size / 2 + 0.5, y - size / 2 + 0.5
            r = size * 0.22
            inside = abs(cx) <= size / 2 - r or abs(cy) <= size / 2 - r or (abs(cx) - (size / 2 - r)) ** 2 + (abs(cy) - (size / 2 - r)) ** 2 <= r * r
            if not inside:
                raw += b"\x00\x00\x00\x00"; continue
            stripe = abs(cx + cy) < size * 0.09 or abs(cy - size * 0.18) < size * 0.06 and abs(cx) < size * 0.28
            c = (240, 253, 244) if stripe else rgb
            raw += bytes(c) + b"\xff"
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "autobot", "icons")
os.makedirs(out, exist_ok=True)
for s in (16, 48, 128):
    with open(os.path.join(out, f"{s}.png"), "wb") as f: f.write(png(s))
print("icons written to", os.path.abspath(out))
