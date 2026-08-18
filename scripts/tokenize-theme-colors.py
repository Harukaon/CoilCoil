#!/usr/bin/env python3
"""One-off codemod: rewrite neutral grays in renderer CSS into theme-driven hsl() tokens.

Neutral colors (max(r,g,b)-min(r,g,b) <= NEUTRAL_DELTA) become
  hsl(var(--th) var(--ts) calc(var(--tlb) + var(--tla) * L%))
so a theme only has to override the hue (--th), saturation (--ts) and the
lightness mapping (--tla/--tlb, e.g. -0.94/97% flips light to dark).

Chromatic accents (status greens/reds/ambers) and dark translucent shadows
are intentionally left untouched.
"""
import re
import sys
from pathlib import Path

NEUTRAL_DELTA = 14          # max channel spread considered "neutral gray"
ALPHA_KEEP_BELOW_L = 38.0   # translucent colors darker than this stay as-is (shadows/overlays)

HEX_RE = re.compile(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")
RGB_RE = re.compile(r"rgb\((\d+)\s+(\d+)\s+(\d+)\s*/\s*([\d.]+%)\)")


def lightness(r: int, g: int, b: int) -> float:
    return (max(r, g, b) + min(r, g, b)) / 2 / 255 * 100


def fmt_l(value: float) -> str:
    rounded = round(value, 1)
    return f"{int(rounded)}%" if rounded == int(rounded) else f"{rounded}%"


def token(l: float, alpha: str | None = None) -> str:
    suffix = f" / {alpha}" if alpha else ""
    return f"hsl(var(--th) var(--ts) calc(var(--tlb) + var(--tla) * {fmt_l(l)}){suffix})"


def convert_hex(match: re.Match[str]) -> str:
    raw = match.group(1)
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    r, g, b = (int(raw[i:i + 2], 16) for i in (0, 2, 4))
    if max(r, g, b) - min(r, g, b) > NEUTRAL_DELTA:
        return match.group(0)
    return token(lightness(r, g, b))


def convert_rgb(match: re.Match[str]) -> str:
    r, g, b = (int(match.group(i)) for i in (1, 2, 3))
    if max(r, g, b) - min(r, g, b) > NEUTRAL_DELTA:
        return match.group(0)
    l = lightness(r, g, b)
    if l < ALPHA_KEEP_BELOW_L:
        return match.group(0)
    return token(l, match.group(4))


def main() -> None:
    changed = 0
    for path in map(Path, sys.argv[1:]):
        text = path.read_text()
        next_text = RGB_RE.sub(convert_rgb, HEX_RE.sub(convert_hex, text))
        if next_text != text:
            path.write_text(next_text)
            changed += 1
            print(f"tokenized {path}")
    print(f"{changed} file(s) rewritten")


if __name__ == "__main__":
    main()
