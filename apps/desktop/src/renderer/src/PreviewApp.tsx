import { Code2, Eye, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreviewDocument } from "../../shared/desktop-api";

export default function PreviewApp({ id }: { id: string }): React.JSX.Element {
  const [document, setDocument] = useState<FilePreviewDocument>();
  const [rendered, setRendered] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    const unsubscribe = window.suocode.onFilePreviewUpdated((next) => {
      if (active && next.id === id) setDocument(next);
    });
    void window.suocode.getFilePreview(id).then((next) => {
      if (active) setDocument(next);
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id]);

  if (error) return <main className="preview-error">{error}</main>;
  if (!document) return <main className="preview-loading">正在打开文件…</main>;
  const canRender = document.kind === "markdown" || document.kind === "html";
  return (
    <main className="preview-window">
      <header className="preview-window-header window-drag">
        <div className="preview-window-title"><FileText size={15} /><strong>{document.name}</strong><span title={document.path}>{document.path}</span></div>
        {canRender ? <div className="preview-mode no-drag"><button className={!rendered ? "active" : ""} type="button" onClick={() => setRendered(false)}><Code2 size={14} />源码</button><button className={rendered ? "active" : ""} type="button" onClick={() => setRendered(true)}><Eye size={14} />预览</button></div> : null}
      </header>
      {document.truncated ? <div className="preview-warning">文件较大，仅显示前一部分内容。</div> : null}
      <section className="preview-window-content">
        {document.kind === "pdf" ? <embed className="pdf-preview" src={document.content} type="application/pdf" /> : null}
        {document.kind === "markdown" && rendered ? <article className="preview-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{document.content}</ReactMarkdown></article> : null}
        {document.kind === "html" && rendered ? <iframe className="html-preview" title={document.name} sandbox="" srcDoc={document.content} /> : null}
        {(document.kind === "text" || !rendered) ? <pre className="text-preview"><code>{document.content}</code></pre> : null}
      </section>
      <footer className="preview-window-status"><span>{document.kind.toUpperCase()}</span><span>{new Date(document.updatedAt).toLocaleTimeString("zh-CN")}</span><span>实时更新</span></footer>
    </main>
  );
}
