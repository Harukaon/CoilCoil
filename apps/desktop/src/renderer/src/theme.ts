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
 * 暗色色调。浅色是 CoilCoil 自己的取色，只有一套；暗色的明度阶梯和中性色饱和度
 * 分别拟合自几套成熟的暗色主题，见 theme-tokens.css 顶部的说明。
 */
export type DarkTone = "graphite" | "midnight" | "mauve" | "ember";
export type LightTone = "paper" | "snow" | "slate" | "latte";
export type Tone = LightTone | DarkTone;

/**
 * 字体。界面字体和代码/终端的等宽字体分开选，因为它们要解决的问题不一样：
 * 一个是正文读起来舒不舒服，一个是对不对得齐。
 *
 * 只用系统自带的字体，不打包也不下载任何字体文件——体积和授权都不值当。每一档
 * 都写完整的兜底链，并且中文一律兜到 PingFang SC（衬线那一档兜到宋体），不然选
 * 了一个只有西文的字体，中文会掉到系统随便挑的一个字形上，中英混排会很难看。
 */
export type UiFont = "system" | "helvetica" | "serif" | "mono";
export type MonoFont = "sf-mono" | "menlo" | "monaco" | "pt-mono";

export interface FontDefinition<Id extends string> {
  id: Id;
  /** 设置界面展示名 */
  name: string;
  description: string;
  /**
   * 完整的 font-family 栈。
   *
   * 字体栈只在这里存一份：主题令牌可以全放 CSS，是因为 CSS 自己就能按
   * `data-*` 选择器切换；字体不行——设置界面的每张卡片都要用「那一档」的字体
   * 画出示例文字，那是行内样式，只能从 JS 拿。所以由 theme.ts 把选中的那一档
   * 写进 `--font-ui` / `--font-mono`，CSS 一侧只引用变量。
   */
  stack: string;
}

export type UiFontDefinition = FontDefinition<UiFont>;
export type MonoFontDefinition = FontDefinition<MonoFont>;

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

export const THEME_STORAGE_KEY = "coilcoil.theme";
export const SURFACE_STORAGE_KEY = "coilcoil.surface";
export const DARK_TONE_STORAGE_KEY = "coilcoil.dark-tone";
export const LIGHT_TONE_STORAGE_KEY = "coilcoil.light-tone";
export const UI_FONT_STORAGE_KEY = "coilcoil.font-ui";
export const MONO_FONT_STORAGE_KEY = "coilcoil.font-mono";
export const WINDOW_OPACITY_STORAGE_KEY = "coilcoil.window-opacity";
export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DEFAULT_SURFACE_STYLE: SurfaceStyle = "layered";
export const DEFAULT_DARK_TONE: DarkTone = "graphite";
export const DEFAULT_LIGHT_TONE: LightTone = "paper";
export const DEFAULT_UI_FONT: UiFont = "system";
export const DEFAULT_MONO_FONT: MonoFont = "sf-mono";

export const THEME_MODES: ThemeModeDefinition[] = [
  { id: "light", name: "浅色", description: "暖纸色调的明亮界面。" },
  { id: "dark", name: "暗色", description: "低亮度的暖中性暗色界面。" },
  { id: "system", name: "跟随系统", description: "随系统外观设置自动切换。" },
];

export const LIGHT_TONES: LightToneDefinition[] = [
  {
    id: "paper",
    name: "纯白",
    description: "纯白配 #F9F9F9 的中性两档，不带任何色偏。",
    swatch: { hue: 0, saturation: 0, chrome: 97.6, content: 100, raised: 100, border: 89.6, muted: 56, text: 13.7 },
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
    description: "CoilCoil 自己的暖中性，按同一套阶梯重排。",
    swatch: { hue: 40, saturation: 8, chrome: 9.5, content: 12.5, raised: 19, border: 18.9, muted: 60, text: 79 },
  },
];

/** 中文兜底：无衬线一律 PingFang SC，Windows 上退到微软雅黑。 */
const CJK_SANS = '"PingFang SC", "Microsoft YaHei"';
/** 衬线那一档的中文兜底：宋体，兜到思源宋体，再到系统衬线。 */
const CJK_SERIF = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC"';

export const UI_FONTS: UiFontDefinition[] = [
  {
    id: "system",
    name: "系统默认",
    // 和这一档的取值必须与 styles.css 里 var(--font-ui, …) 的兜底一致。
    description: "跟随系统的界面字体，macOS 上是 SF Pro 配苹方。",
    stack: `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", ${CJK_SANS}, sans-serif`,
  },
  {
    id: "helvetica",
    name: "无衬线",
    description: "Helvetica Neue，字形比系统默认更窄一点。",
    stack: `"Helvetica Neue", Helvetica, Arial, ${CJK_SANS}, sans-serif`,
  },
  {
    id: "serif",
    name: "衬线",
    description: "西文用 Iowan Old Style，中文用宋体，长文读起来更书面。",
    stack: `"Iowan Old Style", "Times New Roman", Georgia, ${CJK_SERIF}, ${CJK_SANS}, serif`,
  },
  {
    id: "mono",
    name: "等宽",
    description: "整个界面都用等宽字体，中文仍然是苹方。",
    stack: `ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, ${CJK_SANS}, monospace`,
  },
];

export const MONO_FONTS: MonoFontDefinition[] = [
  {
    id: "sf-mono",
    name: "SF Mono",
    description: "macOS 自带的等宽字体，CoilCoil 一直用的这一档。",
    stack: `ui-monospace, "SF Mono", "SFMono-Regular", "Cascadia Code", Menlo, Consolas, ${CJK_SANS}, monospace`,
  },
  {
    id: "menlo",
    name: "Menlo",
    description: "字腔更开，小字号下更容易分清 0 和 O。",
    stack: `Menlo, "SFMono-Regular", Consolas, ${CJK_SANS}, monospace`,
  },
  {
    id: "monaco",
    name: "Monaco",
    description: "macOS 的老牌等宽字体，笔画偏粗。",
    stack: `Monaco, Menlo, Consolas, ${CJK_SANS}, monospace`,
  },
  {
    id: "pt-mono",
    name: "PT Mono",
    description: "字形偏窄，同样宽度能多放几个字符。",
    stack: `"PT Mono", Menlo, Consolas, ${CJK_SANS}, monospace`,
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

/**
 * 把存下来的字符串解成一档字体。
 *
 * 单独抽出来是为了能直接测：`storedUiFont` 要读 window.localStorage，测试里没
 * 有 window；解析规则本身是纯函数，认不出来就回落到默认那一档。
 */
export function resolveUiFont(value: string | null | undefined): UiFont {
  return UI_FONTS.some((font) => font.id === value) ? value as UiFont : DEFAULT_UI_FONT;
}

export function resolveMonoFont(value: string | null | undefined): MonoFont {
  return MONO_FONTS.some((font) => font.id === value) ? value as MonoFont : DEFAULT_MONO_FONT;
}

export function uiFontStack(id: UiFont): string {
  return (UI_FONTS.find((font) => font.id === id) ?? UI_FONTS[0]).stack;
}

export function monoFontStack(id: MonoFont): string {
  return (MONO_FONTS.find((font) => font.id === id) ?? MONO_FONTS[0]).stack;
}

/**
 * 整窗透明度。
 *
 * 真正的存档在主进程那边（userData/window.json）——只有它能在窗口 show() 之前
 * 就把值应用上，不然启动时会先不透明地画一帧再跳一下。这里再存一份到
 * localStorage，纯粹是为了设置界面打开时知道当前停在哪一档，不参与实际生效。
 *
 * 档位是离散的，不做无级滑块：外观那一页整页都是「几张卡片里挑一张」，而且透明
 * 度差 1% 肉眼分不出来，给无级滑块只会让人反复微调。
 */
export const WINDOW_OPACITY_LEVELS = [1, 0.96, 0.92, 0.88] as const;
export const DEFAULT_WINDOW_OPACITY = WINDOW_OPACITY_LEVELS[0];

/** 收敛到最近的一档；读不懂或超出范围都回落到不透明。 */
export function resolveWindowOpacity(value: unknown): number {
  const numeric = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_OPACITY;
  let closest: number = DEFAULT_WINDOW_OPACITY;
  for (const level of WINDOW_OPACITY_LEVELS) {
    if (Math.abs(level - numeric) < Math.abs(closest - numeric)) closest = level;
  }
  return closest;
}

export function storedWindowOpacity(): number {
  try {
    return resolveWindowOpacity(window.localStorage.getItem(WINDOW_OPACITY_STORAGE_KEY));
  } catch {
    // localStorage 不可用时回落到不透明。
    return DEFAULT_WINDOW_OPACITY;
  }
}

/** 立刻改变窗口透明度并记住这一档。远程网页端没有窗口可调，那里是空操作。 */
export function applyWindowOpacity(opacity: number): number {
  const level = resolveWindowOpacity(opacity);
  try {
    window.localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(level));
  } catch {
    // 存不下也要让这一次生效。
  }
  void window.coilcoil?.setWindowOpacity?.(level);
  return level;
}

export function storedUiFont(): UiFont {
  try {
    return resolveUiFont(window.localStorage.getItem(UI_FONT_STORAGE_KEY));
  } catch {
    // localStorage 不可用时回落到默认。
    return DEFAULT_UI_FONT;
  }
}

export function storedMonoFont(): MonoFont {
  try {
    return resolveMonoFont(window.localStorage.getItem(MONO_FONT_STORAGE_KEY));
  } catch {
    // localStorage 不可用时回落到默认。
    return DEFAULT_MONO_FONT;
  }
}

/** 此刻生效的等宽字体栈。xterm 不继承 CSS，只能把字体栈直接交给它。 */
export function storedMonoFontStack(): string {
  return monoFontStack(storedMonoFont());
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
  if (fill) void window.coilcoil?.setWindowBackground(fill);
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

/**
 * 字体不参与 paint()：它和明暗、色调、层次没有任何耦合，也不需要同步窗口底色。
 */
function paintFonts(ui: UiFont, mono: MonoFont): void {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", uiFontStack(ui));
  root.style.setProperty("--font-mono", monoFontStack(mono));
}

export function applyUiFont(font: UiFont): void {
  paintFonts(font, storedMonoFont());
  try {
    window.localStorage.setItem(UI_FONT_STORAGE_KEY, font);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

export function applyMonoFont(font: MonoFont): void {
  paintFonts(storedUiFont(), font);
  try {
    window.localStorage.setItem(MONO_FONT_STORAGE_KEY, font);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

/** 启动时在 React 渲染前应用持久化主题与字体，避免闪烁。 */
export function initTheme(): void {
  paint(storedThemeMode(), storedSurfaceStyle(), storedLightTone(), storedDarkTone());
  paintFonts(storedUiFont(), storedMonoFont());
  // 跟随系统时，系统切换要立刻反映出来。
  darkMedia()?.addEventListener("change", () => {
    if (storedThemeMode() === "system") paint("system", storedSurfaceStyle(), storedLightTone(), storedDarkTone());
  });
}
