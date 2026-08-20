import { Check } from "lucide-react";
import { useState } from "react";
import type { CSSProperties } from "react";
import {
  applyDarkTone,
  applyLightTone,
  applySurfaceStyle,
  applyTheme,
  DARK_TONES,
  LIGHT_TONES,
  resolveThemeMode,
  storedDarkTone,
  storedLightTone,
  storedSurfaceStyle,
  storedThemeMode,
  SURFACE_STYLES,
  THEME_MODES,
  type DarkTone,
  type LightTone,
  type ResolvedTheme,
  type SurfaceStyle,
  type ThemeMode,
  type ToneDefinition,
} from "../../theme";

type AnyTone = ToneDefinition<LightTone | DarkTone>;

/**
 * 预览色块。取值来自同一份色调定义，所以没被选中的那张卡片也显示它自己的真实
 * 配色，而不是当前生效的那套。
 */
function previewStyle(tone: AnyTone, surface: SurfaceStyle): CSSProperties {
  const { hue, saturation, chrome, content, raised, border, muted, text } = tone.swatch;
  const paint = (lightness: number): string => `hsl(${hue} ${saturation}% ${lightness}%)`;
  const fills = surface === "layered"
    ? { side: chrome, pane: content, composer: raised }
    : { side: content, pane: content, composer: content };
  return {
    "--preview-shell": paint(fills.pane),
    "--preview-side": paint(fills.side),
    "--preview-card": paint(fills.composer),
    "--preview-border": paint(border),
    "--preview-text": paint(text),
    "--preview-muted": paint(muted),
  } as CSSProperties;
}

function ThemePreview({ tone, surface }: { tone: AnyTone; surface: SurfaceStyle }): React.JSX.Element {
  return (
    <span aria-hidden className="theme-preview" style={previewStyle(tone, surface)}>
      <span className="theme-preview-side" />
      <span className="theme-preview-main">
        <span className="theme-preview-line wide" />
        <span className="theme-preview-line" />
        <span className="theme-preview-bubble" />
      </span>
    </span>
  );
}

function ToneGrid<Id extends string>({ label, tones, active, surface, onPick }: {
  label: string;
  tones: readonly ToneDefinition<Id>[];
  active: Id;
  surface: SurfaceStyle;
  onPick: (id: Id) => void;
}): React.JSX.Element {
  return (
    <div className="theme-grid" role="radiogroup" aria-label={label}>
      {tones.map((tone) => (
        <button
          key={tone.id}
          className={`theme-card${tone.id === active ? " active" : ""}`}
          type="button"
          role="radio"
          aria-checked={tone.id === active}
          onClick={() => onPick(tone.id)}
        >
          <ThemePreview tone={tone as AnyTone} surface={surface} />
          <span className="theme-card-copy">
            <strong>{tone.name}{tone.id === active ? <Check size={12} /> : null}</strong>
            <small>{tone.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function AppearanceSettings(): React.JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(storedThemeMode);
  const [surface, setSurface] = useState<SurfaceStyle>(storedSurfaceStyle);
  const [lightToneId, setLightToneId] = useState<LightTone>(storedLightTone);
  const [darkToneId, setDarkToneId] = useState<DarkTone>(storedDarkTone);

  const lightTone = LIGHT_TONES.find((tone) => tone.id === lightToneId) ?? LIGHT_TONES[0];
  const darkTone = DARK_TONES.find((tone) => tone.id === darkToneId) ?? DARK_TONES[0];
  // 明暗与层次的预览按此刻实际生效的那一套色调画。
  const activeTone = (resolveThemeMode(mode) === "dark" ? darkTone : lightTone) as AnyTone;
  const previewFor = (theme: ResolvedTheme): AnyTone => (theme === "dark" ? darkTone : lightTone) as AnyTone;

  return (
    <div className="appearance-settings">
      <section className="appearance-section">
        <h3>明暗</h3>
        <p className="appearance-hint">浅色与暗色各自独立取色，暗色不是把浅色反相。</p>
        <div className="theme-grid" role="radiogroup" aria-label="明暗">
          {THEME_MODES.map((option) => (
            <button
              key={option.id}
              className={`theme-card${option.id === mode ? " active" : ""}`}
              type="button"
              role="radio"
              aria-checked={option.id === mode}
              onClick={() => { applyTheme(option.id); setMode(option.id); }}
            >
              {/* 「跟随系统」展示此刻系统实际会给出的那一套。 */}
              <ThemePreview tone={previewFor(resolveThemeMode(option.id))} surface={surface} />
              <span className="theme-card-copy">
                <strong>{option.name}{option.id === mode ? <Check size={12} /> : null}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="appearance-section">
        <h3>浅色色调</h3>
        <p className="appearance-hint">只影响浅色。暖纸是 SuoCode 原本的取色，其余三档分别拟合自 VS Code Light Modern、GitHub Light、Catppuccin Latte。</p>
        <ToneGrid label="浅色色调" tones={LIGHT_TONES} active={lightToneId} surface={surface}
          onPick={(id) => { applyLightTone(id); setLightToneId(id); }} />
      </section>

      <section className="appearance-section">
        <h3>暗色色调</h3>
        <p className="appearance-hint">只影响暗色。分别拟合自 VS Code Dark Modern、Tokyo Night、Catppuccin Mocha，外加 SuoCode 自己的暖中性。</p>
        <ToneGrid label="暗色色调" tones={DARK_TONES} active={darkToneId} surface={surface}
          onPick={(id) => { applyDarkTone(id); setDarkToneId(id); }} />
      </section>

      <section className="appearance-section">
        <h3>界面层次</h3>
        <p className="appearance-hint">侧栏与会话区是同一个底色，还是两个有深浅区分的表面。与明暗、色调都互不影响。</p>
        <div className="theme-grid" role="radiogroup" aria-label="界面层次">
          {SURFACE_STYLES.map((option) => (
            <button
              key={option.id}
              className={`theme-card${option.id === surface ? " active" : ""}`}
              type="button"
              role="radio"
              aria-checked={option.id === surface}
              onClick={() => { applySurfaceStyle(option.id); setSurface(option.id); }}
            >
              <ThemePreview tone={activeTone} surface={option.id} />
              <span className="theme-card-copy">
                <strong>{option.name}{option.id === surface ? <Check size={12} /> : null}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
