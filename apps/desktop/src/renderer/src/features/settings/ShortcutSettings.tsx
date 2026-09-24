import { Keyboard, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { BubbleShortcutState } from "../../../../shared/desktop-api";
import { toastError, toastSuccess } from "../../ui/toast";
import { rendererPlatform } from "../../platform";
import { acceleratorFromKeyPress, formatAccelerator } from "./shortcutAccelerator";

/**
 * The quick-ask bubble's global shortcut.
 *
 * Nothing is registered until it is set here. A global shortcut is taken from
 * every other application on the machine, so CoilCoil claims one only when
 * asked, and the combination is tested by actually registering it - the system
 * is the only authority on whether it was free.
 */
export function ShortcutSettings(): React.JSX.Element {
  const [state, setState] = useState<BubbleShortcutState>();
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.coilcoil.getBubbleShortcut()
      .then((next) => { if (!cancelled) setState(next); })
      .catch((caught: unknown) => { if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { cancelled = true; };
  }, []);

  const apply = async (accelerator?: string): Promise<void> => {
    setSaving(true);
    setHint(undefined);
    try {
      const next = await window.coilcoil.setBubbleShortcut(accelerator);
      setState(next);
      if (!accelerator) toastSuccess("已取消快捷键。");
      else if (next.registered) toastSuccess("快捷键已生效。");
      else setHint(next.error ?? "这个快捷键无法注册，换一个试试。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
      setRecording(false);
    }
  };

  const platform = rendererPlatform();
  const current = state?.accelerator;

  return (
    <div className="shortcut-settings">
      <section className="shortcut-section">
        <h3>快速提问气泡</h3>
        <p className="shortcut-lead">按下快捷键，在屏幕中央弹出一个输入框，向主目录里的会话提问。默认不占用任何快捷键。</p>

      <div className="shortcut-row">
        <button
          className={`shortcut-capture ${recording ? "recording" : ""}`}
          type="button"
          disabled={saving}
          aria-label="设置快速提问气泡的快捷键"
          onClick={() => { setRecording(true); setHint(undefined); }}
          onBlur={() => setRecording(false)}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            if (event.key === "Escape") { setRecording(false); return; }
            const result = acceleratorFromKeyPress(event);
            if (!result.ok) { setHint(result.reason); return; }
            void apply(result.accelerator);
          }}
        >
          {saving ? <LoaderCircle className="spin" size={13} /> : <Keyboard size={13} />}
          <span>{recording ? "按下想用的组合…" : current ? formatAccelerator(current, platform) : "未设置"}</span>
        </button>
        {current ? (
          <button className="shortcut-clear" type="button" disabled={saving} aria-label="取消快捷键" onClick={() => void apply(undefined)}>
            <X size={13} />取消
          </button>
        ) : state?.suggestion ? (
          <button className="shortcut-clear" type="button" disabled={saving} onClick={() => void apply(state.suggestion)}>
            使用 {formatAccelerator(state.suggestion, platform)}
          </button>
        ) : null}
      </div>

      {hint ? <p className="shortcut-hint error">{hint}</p> : null}
      {current && state?.registered === false && !hint
        ? <p className="shortcut-hint error">{state.error ?? "这个快捷键当前没有生效，可能已被其他应用占用。"}</p>
        : null}
      {!current ? <p className="shortcut-hint">点上面的方框，然后按下想用的组合键。</p> : null}
      </section>
    </div>
  );
}
