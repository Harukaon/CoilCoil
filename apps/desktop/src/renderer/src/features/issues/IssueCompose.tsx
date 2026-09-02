import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ListPlus, X } from "lucide-react";
import type { PromptImage } from "@coilcoil/runtime-protocol";
import type { IssuePriority } from "../../../../shared/desktop-api";
import { Select } from "../../ui/Select";
import { ISSUE_PRIORITY_NAME } from "./issueModel";
import { IssueImagePicker, imageDropHandlers } from "./IssueImages";

export interface IssueDraft {
  title: string;
  body: string;
  priority: IssuePriority;
  images: PromptImage[];
}

/**
 * 提一条任务。
 *
 * 原来这是工具条上并排的两个单行输入框。用户说得很直接：「任务怎么可能简简单单用
 * 一个描述能解决吗」——一条任务往往要说清在哪儿看到的、现在是什么样、期望是什么样，
 * 还经常得配张截图，一个 260px 的单行框装不下这些。所以改成弹窗：描述是多行的，
 * 图直接粘进来。
 *
 * 弹窗而不是把面板挤宽：提任务是一件有始有终的事，摊开来写完、提交、关掉，中间
 * 不需要同时看着看板。
 */
export function IssueCompose({
  onClose,
  onSubmit,
}: {
  onClose(): void;
  onSubmit(draft: IssueDraft): void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [images, setImages] = useState<PromptImage[]>([]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit({ title: trimmed, body: body.trim(), priority, images });
    onClose();
  };

  return createPortal(
    <div
      className="issue-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <form
        className="issue-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="提一条任务"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
        {...imageDropHandlers((next) => setImages((current) => [...current, ...next]))}
      >
        <header>
          <span className="settings-icon"><ListPlus size={16} /></span>
          <div>
            <strong>提一条任务</strong>
            <small>说清楚在哪儿、现在什么样、你想要什么样；截图直接粘进来</small>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="issue-dialog-body">
          <input
            /* 弹窗一开就该能直接打字，不然还要先点一下那个框。 */
            autoFocus
            value={title}
            placeholder="一句话说清是什么事"
            aria-label="任务标题"
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            value={body}
            placeholder="展开说说：在哪个界面、怎么复现、期望改成什么样（可留空）"
            aria-label="任务描述"
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              // 描述是多行的，回车得留给换行，所以提交是 ⌘/Ctrl + 回车。
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
            }}
          />
          <IssueImagePicker images={images} onChange={setImages} />
        </div>

        <footer>
          <Select
            className="issue-select"
            value={priority}
            ariaLabel="优先级"
            options={(["high", "medium", "low"] as const).map((level) => ({ value: level, label: `优先级 ${ISSUE_PRIORITY_NAME[level]}` }))}
            onChange={(value) => setPriority(value as IssuePriority)}
          />
          <button className="issue-ghost" type="button" onClick={onClose}>取消</button>
          <button className="issue-primary" type="submit" disabled={!title.trim()}>提交到待处理</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
