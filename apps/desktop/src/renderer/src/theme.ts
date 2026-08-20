/**
 * 全局主题：浅色、暗色，或跟随系统。
 *
 * 具体颜色都在 theme-tokens.css 里（明度令牌 `--l-*` 与语义色令牌 `--c-*`），
 * 暗色是按 Radix Colors 的 sand 标度推导的一套独立取值，不是把浅色反相。
 * 这里只负责在 `<html>` 上挂 `data-theme="dark"`、持久化选择，以及在「跟随
 * 系统」时监听系统外观变化。
 */

export type ThemeMode = "light" | "dark" | "system";
/** 真正被绘制出来的两套配色。 */
export type ResolvedTheme = "light" | "dark";

/**
 * 界面层次：左侧栏与会话区是同一个表面，还是两个有深浅区分的表面。
 *
 * 分层只发生在左侧栏那一刀上；右栏始终跟会话区同色。
 *
 * 明暗和层次是两件独立的事 —— 浅色可以分栏，暗色也可以齐平 —— 所以它们各自
 * 存一个选择，而不是把组合数铺成一长串主题。
 */
export type SurfaceStyle = "flat" | "layered";

/**
 * 暗色色调。浅色是 SuoCode 自己的取色，只有一套；暗色的明度阶梯和中性色饱和度
 * 分别拟合自几套成熟的暗色主题，见 theme-tokens.css 顶部的说明。
 */
export type DarkTone = "graphite" | "midnight" | "mauve" | "ember";
export type LightTone = "paper" | "snow" | "slate" | "latte";
export type Tone = LightTone | DarkTone;

export interface ThemeModeDefinition {
  id: ThemeMode;
  /** 设置界面展示名 */
  name: string;
  description: string;
}

export interface SurfaceStyleDefinition {
  id: SurfaceStyle;
  name: string;
  description: string;
}

export interface ToneDefinition<Id extends string> {
  id: Id;
  name: string;
  description: string;
  /** 预览色块用；与 theme-tokens.css 中同一色调的取值一一对应。 */
  swatch: { hue: number; saturation: number; chrome: number; content: number; raised: number; border: number; muted: number; text: number };
}

export type LightToneDefinition = ToneDefinition<LightTone>;
export type DarkToneDefinition = ToneDefinition<DarkTone>;

export const THEME_STORAGE_KEY = "suocode.theme";
export const SURFACE_STORAGE_KEY = "suocode.surface";
export const DARK_TONE_STORAGE_KEY = "suocode.dark-tone";
export const LIGHT_TONE_STORAGE_KEY = "suocode.light-tone";
export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DEFAULT_SURFACE_STYLE: SurfaceStyle = "flat";
export const DEFAULT_DARK_TONE: DarkTone = "graphite";
export const DEFAULT_LIGHT_TONE: LightTone = "paper";

export const THEME_MODES: ThemeModeDefinition[] = [
  { id: "light", name: "浅色", description: "暖纸色调的明亮界面。" },
  { id: "dark", name: "暗色", description: "低亮度的暖中性暗色界面。" },
  { id: "system", name: "跟随系统", description: "随系统外观设置自动切换。" },
];

export const LIGHT_TONES: LightToneDefinition[] = [
  {
    id: "paper",
    name: "暖纸",
    description: "SuoCode 自己的暖纸色调，取值原样保留。",
    swatch: { hue: 60, saturation: 6, chrome: 93.4, content: 96.9, raised: 100, border: 86.1, muted: 56, text: 13.7 },
  },
  {
    id: "snow",
    name: "雪白",
    description: "中性无色相的亮白，阶梯取自 VS Code Light Modern。",
    swatch: { hue: 0, saturation: 0, chrome: 97.3, content: 99.2, raised: 100, border: 91.2, muted: 46.3, text: 23.1 },
  },
  {
    id: "slate",
    name: "石板",
    description: "偏冷的蓝灰白，阶梯取自 GitHub Light。",
    swatch: { hue: 210, saturation: 20, chrome: 97.6, content: 99.6, raised: 100, border: 88.3, muted: 42.4, text: 14 },
  },
  {
    id: "latte",
    name: "拿铁",
    description: "整体压低一档的柔和米蓝，阶梯取自 Catppuccin Latte。",
    swatch: { hue: 220, saturation: 23, chrome: 92.4, content: 95.7, raised: 98.5, border: 85.6, muted: 47.6, text: 35.5 },
  },
];

export const DARK_TONES: DarkToneDefinition[] = [
  {
    id: "graphite",
    name: "石墨",
    description: "中性无色相，阶梯取自 VS Code Dark Modern。",
    swatch: { hue: 0, saturation: 0, chrome: 9.4, content: 12.2, raised: 19.2, border: 18.6, muted: 61.6, text: 80 },
  },
  {
    id: "midnight",
    name: "深蓝夜",
    description: "偏蓝的冷色夜，阶梯取自 Tokyo Night。",
    swatch: { hue: 232, saturation: 20, chrome: 10.2, content: 13, raised: 21, border: 20.4, muted: 65, text: 80 },
  },
  {
    id: "mauve",
    name: "藕紫夜",
    description: "偏紫、整体更亮一档，阶梯取自 Catppuccin Mocha。",
    swatch: { hue: 237, saturation: 18, chrome: 12, content: 15, raised: 23, border: 22.2, muted: 67, text: 80 },
  },
  {
    id: "ember",
    name: "暖夜",
    description: "SuoCode 自己的暖中性，按同一套阶梯重排。",
    swatch: { hue: 40, saturation: 8, chrome: 9.5, content: 12.5, raised: 19, border: 18.9, muted: 60, text: 79 },
  },
];

export const SURFACE_STYLES: SurfaceStyleDefinition[] = [
  { id: "flat", name: "齐平", description: "侧栏与会话区同一个底色，界面连成一片。" },
  { id: "layered", name: "分栏", description: "左侧栏压深，会话区与右栏提亮。" },
];

function darkMedia(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
}

export function storedThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
    // 旧版本存的是具体色调 id（suo / ocean / dark-forest…），按明暗归类。
    if (stored) return stored.startsWith("dark") ? "dark" : "light";
  } catch {
    // localStorage 不可用时回落到默认。
  }
  return DEFAULT_THEME_MODE;
}

export function storedSurfaceStyle(): SurfaceStyle {
  try {
    const stored = window.localStorage.getItem(SURFACE_STORAGE_KEY);
    if (stored === "flat" || stored === "layered") return stored;
  } catch {
    // localStorage 不可用时回落到默认。
  }
  return DEFAULT_SURFACE_STYLE;
}

export function storedLightTone(): LightTone {
  try {
    const stored = window.localStorage.getItem(LIGHT_TONE_STORAGE_KEY);
    if (LIGHT_TONES.some((tone) => tone.id === stored)) return stored as LightTone;
  } catch {
    // localStorage 不可用时回落到默认。
  }
  return DEFAULT_LIGHT_TONE;
}

export function storedDarkTone(): DarkTone {
  try {
    const stored = window.localStorage.getItem(DARK_TONE_STORAGE_KEY);
    if (DARK_TONES.some((tone) => tone.id === stored)) return stored as DarkTone;
  } catch {
    // localStorage 不可用时回落到默认。
  }
  return DEFAULT_DARK_TONE;
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  return darkMedia()?.matches ? "dark" : "light";
}

function paint(mode: ThemeMode, surface: SurfaceStyle, lightTone: LightTone, darkTone: DarkTone): void {
  const root = document.documentElement;
  const resolved = resolveThemeMode(mode);
  if (resolved === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  if (surface === "layered") root.dataset.surface = "layered";
  else delete root.dataset.surface;
  root.dataset.lightTone = lightTone;
  root.dataset.darkTone = darkTone;
  // 窗口是半透明的，露出的画布底色归主进程管。读实际生效的令牌而不是自己再算
  // 一遍，色调改了这里不会漏掉。
  const fill = getComputedStyle(root).getPropertyValue("--shell-fill").trim();
  if (fill) void window.suocode?.setWindowBackground(fill);
}

export function applyTheme(mode: ThemeMode): void {
  paint(mode, storedSurfaceStyle(), storedLightTone(), storedDarkTone());
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

export function applySurfaceStyle(surface: SurfaceStyle): void {
  paint(storedThemeMode(), surface, storedLightTone(), storedDarkTone());
  try {
    window.localStorage.setItem(SURFACE_STORAGE_KEY, surface);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

/** 启动时在 React 渲染前应用持久化主题，避免闪烁。 */
export function applyLightTone(tone: LightTone): void {
  paint(storedThemeMode(), storedSurfaceStyle(), tone, storedDarkTone());
  try {
    window.localStorage.setItem(LIGHT_TONE_STORAGE_KEY, tone);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

export function applyDarkTone(tone: DarkTone): void {
  paint(storedThemeMode(), storedSurfaceStyle(), storedLightTone(), tone);
  try {
    window.localStorage.setItem(DARK_TONE_STORAGE_KEY, tone);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

export function initTheme(): void {
  paint(storedThemeMode(), storedSurfaceStyle(), storedLightTone(), storedDarkTone());
  // 跟随系统时，系统切换要立刻反映出来。
  darkMedia()?.addEventListener("change", () => {
    if (storedThemeMode() === "system") paint("system", storedSurfaceStyle(), storedLightTone(), storedDarkTone());
  });
}
