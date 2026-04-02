#!/usr/bin/env python3
"""Generate a simple umbrella launcher icon for the agentic suite."""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path


PALETTE = {
    "bg": (11, 14, 24, 255),
    "glow": (76, 118, 255, 255),
    "glow_soft": (34, 68, 162, 255),
    "panel": (24, 31, 52, 255),
    "panel_edge": (98, 118, 171, 255),
    "signal": (148, 229, 214, 255),
    "signal_dark": (54, 107, 116, 255),
    "agent": (255, 174, 96, 255),
    "agent_dark": (197, 106, 55, 255),
    "paper": (239, 241, 248, 255),
    "outline": (6, 9, 14, 255),
}


def chunk(tag: bytes, data: bytes) -> bytes:
    payload = tag + data
    return struct.pack("!I", len(data)) + payload + struct.pack("!I", zlib.crc32(payload) & 0xFFFFFFFF)


def write_png(path: Path, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    height = len(pixels)
    width = len(pixels[0]) if height else 0
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for rgba in row:
            raw.extend(rgba)
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    payload = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(payload)


def canvas(size: int) -> list[list[tuple[int, int, int, int]]]:
    return [[PALETTE["bg"] for _ in range(size)] for _ in range(size)]


def fill(pixels, x, y, w, h, color):
    max_y = len(pixels)
    max_x = len(pixels[0]) if max_y else 0
    for row in range(max(0, y), min(max_y, y + h)):
      for col in range(max(0, x), min(max_x, x + w)):
        pixels[row][col] = color


def dot(pixels, x, y, color):
    if 0 <= y < len(pixels) and 0 <= x < len(pixels[y]):
        pixels[y][x] = color


def scene(pixels):
    size = len(pixels)
    scale = max(1, size // 32)
    fill(pixels, 0, 0, size, size, PALETTE["bg"])
    fill(pixels, 4 * scale, 6 * scale, 24 * scale, 18 * scale, PALETTE["panel"])
    fill(pixels, 4 * scale, 6 * scale, 24 * scale, scale, PALETTE["panel_edge"])
    fill(pixels, 4 * scale, 23 * scale, 24 * scale, scale, PALETTE["panel_edge"])
    fill(pixels, 5 * scale, 7 * scale, 22 * scale, 16 * scale, PALETTE["glow_soft"])

    fill(pixels, 9 * scale, 9 * scale, 6 * scale, 4 * scale, PALETTE["signal_dark"])
    fill(pixels, 10 * scale, 10 * scale, 4 * scale, 2 * scale, PALETTE["signal"])
    fill(pixels, 17 * scale, 9 * scale, 6 * scale, 4 * scale, PALETTE["signal_dark"])
    fill(pixels, 18 * scale, 10 * scale, 4 * scale, 2 * scale, PALETTE["signal"])
    fill(pixels, 13 * scale, 15 * scale, 6 * scale, 5 * scale, PALETTE["agent"])
    fill(pixels, 14 * scale, 16 * scale, 4 * scale, 3 * scale, PALETTE["agent_dark"])
    fill(pixels, 14 * scale, 20 * scale, scale, 4 * scale, PALETTE["agent_dark"])
    fill(pixels, 17 * scale, 20 * scale, scale, 4 * scale, PALETTE["agent_dark"])
    dot(pixels, 15 * scale, 17 * scale, PALETTE["outline"])
    dot(pixels, 17 * scale, 17 * scale, PALETTE["outline"])

    fill(pixels, 7 * scale, 18 * scale, 4 * scale, 3 * scale, PALETTE["paper"])
    fill(pixels, 21 * scale, 18 * scale, 4 * scale, 3 * scale, PALETTE["paper"])
    fill(pixels, 10 * scale, 5 * scale, 12 * scale, scale, PALETTE["glow"])
    for offset in range(5):
        dot(pixels, (8 + offset) * scale, 26 * scale, PALETTE["glow"])
        dot(pixels, (19 + offset) * scale, 26 * scale, PALETTE["glow"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Agentic Suite launcher icon.")
    parser.add_argument("--out", required=True, help="Output PNG path.")
    parser.add_argument("--size", type=int, default=256, help="Output square size in pixels.")
    args = parser.parse_args()

    size = max(64, int(args.size))
    pixels = canvas(size)
    scene(pixels)
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_png(out_path, pixels)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
