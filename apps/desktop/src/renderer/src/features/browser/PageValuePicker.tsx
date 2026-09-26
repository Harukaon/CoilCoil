import { useEffect, useRef } from "react";
import type { BrowserValuePicker } from "../../../../shared/desktop-api";

/**
 * 网页里日期、时间、颜色输入框的选择器。
 *
 * 离屏页面里浏览器的选择器弹层画不出来，所以在输入框的位置放一个同类型的隐形输入框，打开
 * App 窗口里 Chromium 自己的选择器——日历、时间、系统颜色面板都和 Chrome 里一模一样，不是
 * 仿的。选的值交回去写进页面；选择器关了（选完、Esc、点别处），这里跟着收起。
 *
 * 浏览器只让「用户刚按过鼠标或键盘」时打开选择器：面板是在用户按下的那一刻问的页面，来得及；
 * 真来不及了（打不开）就当没开过。
 */
export function PageValuePicker({ picker, scale, onValue, onClose }: {
  picker: BrowserValuePicker;
  scale: number;
  /** 选了一个值；final 是选完了（浏览器发了 change），颜色面板拖着选时一路是 false。 */
  onValue(value: string, final: boolean): void;
  onClose(): void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const handlers = useRef({ onValue, onClose });
  handlers.current = { onValue, onClose };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const changed = (): void => handlers.current.onValue(input.value, true);
    input.addEventListener("change", changed);
    try {
      input.showPicker();
    } catch {
      handlers.current.onClose();
      return () => input.removeEventListener("change", changed);
    }
    const timer = window.setInterval(() => {
      let open = false;
      try {
        open = input.matches(":open");
      } catch {
        open = false;
      }
      if (!open) {
        window.clearInterval(timer);
        handlers.current.onClose();
      }
    }, 200);
    return () => {
      window.clearInterval(timer);
      input.removeEventListener("change", changed);
    };
  }, []);

  return (
    <input
      ref={inputRef}
      className="browser-value-picker"
      type={picker.type}
      defaultValue={picker.value}
      min={picker.min || undefined}
      max={picker.max || undefined}
      step={picker.step || undefined}
      tabIndex={-1}
      aria-hidden="true"
      style={{
        left: picker.rect.x * scale,
        top: picker.rect.y * scale,
        width: Math.max(1, picker.rect.width * scale),
        height: Math.max(1, picker.rect.height * scale),
      }}
      onInput={(event) => onValue(event.currentTarget.value, false)}
    />
  );
}
