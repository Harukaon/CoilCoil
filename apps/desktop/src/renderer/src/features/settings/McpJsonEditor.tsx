import { FileJson, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { McpConfigurationSnapshot, McpJsonDocument } from "@suocode/runtime-protocol";
import { validateMcpJsonText } from "@suocode/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";

export function McpJsonEditor({
  open,
  cwd,
  runtimeId,
  onClose,
  onSaved,
}: {
  open: boolean;
  cwd?: string;
  runtimeId?: string;
  onClose: () => void;
  onSaved: (snapshot: McpConfigurationSnapshot) => void;
}): React.JSX.Element | null {
  const [path, setPath] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void window.suocode.request<McpJsonDocument>({ type: "get_mcp_json" }, runtimeId)
      .then((document) => {
        if (cancelled) return;
        if (!document || typeof document.path !== "string" || typeof document.content !== "string") {
          throw new Error("运行时未返回 mcp.json，请重启应用后再试。");
        }
        setPath(document.path);
        setDraft(document.content);
      })
      .catch((caught) => {
        if (cancelled) return;
        toastError(caught instanceof Error ? caught.message : String(caught));
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally omit onClose: parent may pass an unstable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtimeId]);

  const validation = useMemo(() => validateMcpJsonText(draft), [draft]);

  if (!open) return null;

  const save = async (): Promise<void> => {
    if (!validation.ok) {
      toastError(validation.error);
      return;
    }
    setSaving(true);
    try {
      const snapshot = await window.suocode.request<McpConfigurationSnapshot>({
        type: "save_mcp_json",
        content: draft,
        cwd,
      }, runtimeId);
      onSaved(snapshot);
      toastSuccess("已保存 mcp.json");
      onClose();
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-json-overlay" role="dialog" aria-modal="true" aria-labelledby="mcp-json-title">
      <div className="mcp-json-dialog">
        <header>
          <div>
            <strong id="mcp-json-title"><FileJson size={15} />编辑 mcp.json</strong>
            <small title={path}>{path || "…"}</small>
          </div>
          <button type="button" aria-label="关闭" disabled={saving} onClick={onClose}><X size={15} /></button>
        </header>
        <p className="mcp-json-hint">格式与 Cursor 的 <code>mcp.json</code> 一致。保存前会校验 JSON，不合法则拒绝写入，避免 MCP 不可用。</p>
        {loading ? (
          <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载配置…</div>
        ) : (
          <textarea
            className="mcp-json-editor"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-invalid={!validation.ok}
          />
        )}
        <footer>
          <span className={validation.ok ? "ok" : "error"}>
            {loading ? "" : validation.ok ? "JSON 合法" : validation.error}
          </span>
          <div>
            <button type="button" disabled={saving} onClick={onClose}>取消</button>
            <button className="primary-button" type="button" disabled={loading || saving || !validation.ok} onClick={() => void save()}>
              {saving ? <LoaderCircle className="spin" size={13} /> : null}
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
