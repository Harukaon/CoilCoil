/**
 * 全局主题。所有中性灰在 CSS 中已表达为
 * `hsl(var(--th) var(--ts) calc(var(--tlb) + var(--tla) * L%))`，
 * 因此一个主题就是一组 { 色相, 饱和度, 明度映射 } 覆盖（见 styles.css 顶部的
 * `[data-theme=...]` 块）。这里维护主题清单、持久化与应用逻辑。
 */

export interface ThemeDefinition {
  id: string;
  /** 设置界面展示名 */
  name: string;
  description: string;
  /** 预览色块使用的色相/饱和度，与 styles.css 中的定义保持一致 */
  hue: number;
  saturation: string;
  dark: boolean;
}

export const THEME_STORAGE_KEY = "suocode.theme";
export const DEFAULT_THEME_ID = "suo";

export const THEMES: ThemeDefinition[] = [
  { id: "suo", name: "默认暖灰", description: "SuoCode 原生的暖纸色调。", hue: 60, saturation: "6%", dark: false },
  { id: "graphite", name: "石墨", description: "完全中性的冷静灰。", hue: 60, saturation: "0%", dark: false },
  { id: "ocean", name: "海雾蓝", description: "偏冷的蓝灰色调。", hue: 215, saturation: "18%", dark: false },
  { id: "forest", name: "苔原绿", description: "低饱和的绿意背景。", hue: 150, saturation: "14%", dark: false },
  { id: "violet", name: "暮紫", description: "带一点紫罗兰的雾感。", hue: 275, saturation: "15%", dark: false },
  { id: "rose", name: "玫瑰", description: "温暖的粉调纸色。", hue: 350, saturation: "16%", dark: false },
  { id: "amber", name: "琥珀", description: "更浓的暖黄纸感。", hue: 38, saturation: "24%", dark: false },
  { id: "dark", name: "暗夜", description: "中性暗色模式。", hue: 60, saturation: "3%", dark: true },
  { id: "dark-ocean", name: "深海", description: "蓝调的暗色模式。", hue: 220, saturation: "14%", dark: true },
  { id: "dark-forest", name: "夜林", description: "绿调的暗色模式。", hue: 155, saturation: "10%", dark: true },
];

export function storedThemeId(): string {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && THEMES.some((theme) => theme.id === stored)) return stored;
  } catch {
    // localStorage 不可用时回落到默认主题。
  }
  return DEFAULT_THEME_ID;
}

export function applyTheme(id: string): void {
  const theme = THEMES.find((candidate) => candidate.id === id);
  const resolved = theme?.id ?? DEFAULT_THEME_ID;
  if (resolved === DEFAULT_THEME_ID) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = resolved;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    // 持久化失败不影响本次会话生效。
  }
}

/** 启动时在 React 渲染前应用持久化主题，避免闪烁。 */
export function initTheme(): void {
  applyTheme(storedThemeId());
}
