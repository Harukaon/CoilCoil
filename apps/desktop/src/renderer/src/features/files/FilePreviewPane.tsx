import { Code2, Eye, FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreviewDocument } from "../../../../shared/desktop-api";
import "./preview.css";

export function FilePreviewPane({ preview, loading, error, onClose }: {
  preview?: FilePreviewDocument;
  loading: boolean;
  error?: string;
  onClose: () => void;
}): React.JSX.Element {
  const [rendered, setRendered] = useState(true);

  useEffect(() => {
    setRendered(true);
  }, [preview?.id]);

  const canRender = preview?.kind === "markdown" || preview?.kind === "html";
  const embeddedPreview = !loading && !error && (preview?.kind === "pdf" || (preview?.kind === "html" && rendered));
  const kindLabel = preview?.kind === "text"
    ? "文本"
    : preview?.kind === "markdown"
      ? "Markdown"
      : preview?.kind.toUpperCase();

  return (
    <section className={`inline-file-preview ${preview ? "has-document" : ""} ${preview?.truncated ? "has-warning" : ""}`}>
      <header className="inline-preview-header">
        <div className="inline-preview-title">
          <FileText size={14} />
          <strong title={preview?.path}>{preview?.name || "文件预览"}</strong>
        </div>
        <div className="inline-preview-actions">
          {canRender ? (
            <div className="preview-mode">
              <button className={!rendered ? "active" : ""} type="button" title="查看源码" onClick={() => setRendered(false)}><Code2 size={13} /></button>
              <button className={rendered ? "active" : ""} type="button" title="查看预览" onClick={() => setRendered(true)}><Eye size={13} /></button>
            </div>
          ) : null}
          <button className="inline-preview-close" type="button" aria-label="关闭文件预览" title="关闭文件预览" onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      {preview?.truncated ? <div className="preview-warning">文件较大，仅显示前一部分内容。</div> : null}
      <div className={`inline-preview-content ${embeddedPreview ? "embedded" : ""}`}>
        {loading ? <div className="preview-placeholder"><LoaderCircle className="spin" size={16} /><span>正在打开文件…</span></div> : null}
        {!loading && error ? <div className="preview-placeholder error"><FileText size={16} /><span>{error}</span></div> : null}
        {!loading && !error && preview?.kind === "pdf" ? <embed className="pdf-preview" src={preview.content} type="application/pdf" /> : null}
        {!loading && !error && preview?.kind === "markdown" && rendered ? <article className="preview-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown></article> : null}
        {!loading && !error && preview?.kind === "html" && rendered ? <iframe className="html-preview" title={preview.name} sandbox="" srcDoc={preview.content} /> : null}
        {!loading && !error && preview && (preview.kind === "text" || !rendered) ? <pre className="text-preview"><code>{preview.content}</code></pre> : null}
      </div>
      {preview ? <footer className="inline-preview-status"><span>{kindLabel}</span><span>{new Date(preview.updatedAt).toLocaleTimeString("zh-CN")}</span><span>实时更新</span></footer> : null}
    </section>
  );
}
