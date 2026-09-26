import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserSelectPicker } from "../../../../shared/desktop-api";

/**
 * 网页下拉框的选项列表，由面板画在下拉框下面。
 *
 * 离屏页面里原生的下拉弹层出不来，用户一点下拉框，主进程把选项读出来交到这里；选好了
 * 写回页面，和在浏览器里选的一样（页面收到 input、change）。键盘：上下选、回车确定、
 * Esc 放弃，和系统下拉菜单一样。
 */
export function PageSelectPicker({ picker, scale, bounds, onChoose }: {
  picker: BrowserSelectPicker;
  /** 画面相对页面的缩放：页面像素 × scale = 面板里的像素。 */
  scale: number;
  /** 面板画面的大小，列表放不下时往上翻。 */
  bounds: { width: number; height: number };
  onChoose(index: number | null, restoreFocus?: boolean): void;
}): React.JSX.Element {
  const [active, setActive] = useState(picker.selectedIndex);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ top: number; maxHeight: number }>({ top: 0, maxHeight: 320 });

  const left = Math.max(4, Math.min(picker.rect.x * scale, bounds.width - 160));
  const minWidth = Math.max(120, picker.rect.width * scale);
  const below = (picker.rect.y + picker.rect.height) * scale + 2;
  const above = picker.rect.y * scale - 2;

  // 下面放得下就放下面，放不下而上面更宽敞就翻到上面去，和系统下拉菜单一样。
  useLayoutEffect(() => {
    const height = Math.min(listRef.current?.scrollHeight ?? 0, 320);
    const roomBelow = bounds.height - below - 4;
    if (height <= roomBelow || roomBelow >= above) setPlacement({ top: below, maxHeight: Math.max(80, Math.min(320, roomBelow)) });
    else setPlacement({ top: Math.max(4, above - Math.min(height, above - 4)), maxHeight: Math.max(80, Math.min(320, above - 4)) });
  }, [above, below, bounds.height]);

  useEffect(() => {
    const list = listRef.current;
    list?.focus({ preventScroll: true });
    list?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, []);

  const move = (step: 1 | -1): void => {
    for (let index = active + step; index >= 0 && index < picker.options.length; index += step) {
      if (picker.options[index].disabled) continue;
      setActive(index);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
  };

  let group = "";
  return (
    <div
      ref={listRef}
      className="browser-select-picker"
      role="listbox"
      tabIndex={-1}
      aria-label="网页下拉框的选项"
      aria-activedescendant={`${picker.id}-${active}`}
      style={{ left, top: placement.top, minWidth, maxHeight: placement.maxHeight }}
      onMouseDown={(event) => { event.stopPropagation(); event.preventDefault(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (picker.options[active] && !picker.options[active].disabled) onChoose(active); }
        else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onChoose(null); }
      }}
      onBlur={() => onChoose(null, false)}
    >
      {picker.options.map((option, index) => {
        const header = option.group !== group && option.group ? option.group : undefined;
        group = option.group;
        return (
          <div key={index} className="browser-select-row">
            {header ? <div className="browser-select-group">{header}</div> : null}
            <div
              className={`browser-select-option ${index === active ? "active" : ""} ${option.disabled ? "disabled" : ""} ${option.group ? "grouped" : ""}`}
              role="option"
              id={`${picker.id}-${index}`}
              data-index={index}
              aria-selected={index === picker.selectedIndex}
              aria-disabled={option.disabled}
              onMouseEnter={() => { if (!option.disabled) setActive(index); }}
              onClick={() => { if (!option.disabled) onChoose(index); }}
            >
              <span className="browser-select-check">{index === picker.selectedIndex ? <Check size={12} /> : null}</span>
              <span>{option.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
