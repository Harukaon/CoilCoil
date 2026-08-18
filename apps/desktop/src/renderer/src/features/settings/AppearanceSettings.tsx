import { Check } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";
import { applyTheme, storedThemeId, THEMES, type ThemeDefinition } from "../../theme";

/** 与 styles.css 的明度映射保持一致：暗色主题按 97% - 0.94 * L 翻转。 */
function themeLightness(theme: ThemeDefinition, lightness: number): number {
  return theme.dark ? 97 - 0.94 * lightness : lightness;
}

function themeColor(theme: ThemeDefinition, lightness: number): string {
  return `hsl(${theme.hue} ${theme.saturation} ${themeLightness(theme, lightness).toFixed(1)}%)`;
}

function ThemePreview({ theme }: { theme: ThemeDefinition }): React.JSX.Element {
  const style = {
    "--preview-shell": themeColor(theme, 96.9),
    "--preview-side": themeColor(theme, 92),
    "--preview-card": themeColor(theme, 100),
    "--preview-border": themeColor(theme, 87),
    "--preview-text": themeColor(theme, 13.7),
    "--preview-muted": themeColor(theme, 56),
  } as CSSProperties;
  return (
    <span aria-hidden className="theme-preview" style={style}>
      <span className="theme-preview-side" />
      <span className="theme-preview-main">
        <span className="theme-preview-line wide" />
        <span className="theme-preview-line" />
        <span className="theme-preview-bubble" />
      </span>
    </span>
  );
}

export function AppearanceSettings(): React.JSX.Element {
  const [activeId, setActiveId] = useState(storedThemeId);

  const select = (theme: ThemeDefinition): void => {
    applyTheme(theme.id);
    setActiveId(theme.id);
  };

  return (
    <div className="appearance-settings">
      <p className="appearance-hint">选择一个全局色调，立即生效并自动记住。彩色状态提示（成功 / 警告 / 错误）在所有主题下保持一致。</p>
      <div className="theme-grid" role="radiogroup" aria-label="主题">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            className={`theme-card${theme.id === activeId ? " active" : ""}`}
            type="button"
            role="radio"
            aria-checked={theme.id === activeId}
            onClick={() => select(theme)}
          >
            <ThemePreview theme={theme} />
            <span className="theme-card-copy">
              <strong>{theme.name}{theme.id === activeId ? <Check size={12} /> : null}</strong>
              <small>{theme.description}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
