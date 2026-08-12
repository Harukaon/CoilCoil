export const HTML_ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

export function normalizeHtmlZoom(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(HTML_ZOOM_LEVELS[0], Math.min(HTML_ZOOM_LEVELS.at(-1) ?? 200, Math.round(value)));
}

export function stepHtmlZoom(value: number, direction: -1 | 1): number {
  const normalized = normalizeHtmlZoom(value);
  if (direction < 0) {
    return [...HTML_ZOOM_LEVELS].reverse().find((level) => level < normalized) ?? HTML_ZOOM_LEVELS[0];
  }
  return HTML_ZOOM_LEVELS.find((level) => level > normalized) ?? (HTML_ZOOM_LEVELS.at(-1) ?? 200);
}

export function htmlZoomFrameStyle(percent: number): { width: string; height: string; transform: string } {
  const scale = normalizeHtmlZoom(percent) / 100;
  const reciprocal = `${100 / scale}%`;
  return { width: reciprocal, height: reciprocal, transform: `scale(${scale})` };
}
