import { Files } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileNode, ProjectSnapshot } from "@coilcoil/runtime-protocol";
import type { FilePreviewDocument } from "../../../../shared/desktop-api";
import { toastError } from "../../ui/toast";
import { FilePreviewPane } from "./FilePreviewPane";
import { FileTree } from "./FileTree";
import { absoluteProjectPath, previewFileNode, removeTreeNode, replaceDirectoryChildren } from "./filePaths";
import { useFilePanelSplit } from "./useFilePanelSplit";

interface PreviewSelection {
  node: FileNode;
  document?: FilePreviewDocument;
  loading: boolean;
  error?: string;
}

function findFileNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === path && node.kind === "file") return node;
    if (node.children) {
      const found = findFileNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function samePreviewPath(root: string, node: FileNode, document: FilePreviewDocument): boolean {
  const expected = absoluteProjectPath(root, node.path).replaceAll("\\", "/");
  const actual = document.path.replaceAll("\\", "/");
  return actual === expected || actual.endsWith(`/${node.path.replaceAll("\\", "/")}`);
}

export function FilesPanel({ project, runtimeId, activeFilePath, onOpenFile, onCloseFile, onRemovePath }: {
  project: ProjectSnapshot;
  runtimeId?: string;
  activeFilePath?: string;
  onOpenFile?: (node: FileNode) => void;
  onCloseFile?: (path: string) => void;
  onRemovePath?: (path: string) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>(project.files);
  const [selection, setSelection] = useState<PreviewSelection>();
  const previewIdRef = useRef<string | undefined>(undefined);
  const requestIdRef = useRef(0);
  const selectedNodeRef = useRef<FileNode | undefined>(undefined);
  const dirtyRef = useRef(false);
  const { previewShare, beginResize, handleResizeKeyDown } = useFilePanelSplit();

  /**
   * Switching files while an edit is unsaved would throw the typing away without
   * a word, so the switch is refused and the editor stays put: the user saves or
   * cancels first, both of which are one click away in the preview header.
   */
  const blockedByUnsavedEdit = useCallback((): boolean => {
    if (!dirtyRef.current) return false;
    toastError("当前文件有未保存的修改，请先保存或取消编辑。");
    return true;
  }, []);

  const releasePreview = useCallback((id?: string): void => {
    if (!id) return;
    void window.coilcoil.closeFilePreview(id).catch(() => undefined);
  }, []);

  const closePreview = useCallback((): void => {
    requestIdRef.current += 1;
    selectedNodeRef.current = undefined;
    const id = previewIdRef.current;
    previewIdRef.current = undefined;
    setSelection(undefined);
    releasePreview(id);
  }, [releasePreview]);

  useEffect(() => {
    setTree(project.files);
    if (!project.cwd || project.files.length) return;
    void window.coilcoil.listProjectDirectory(project.cwd).then(setTree).catch((caught) => {
      toastError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [project.cwd, project.files]);

  useEffect(() => {
    closePreview();
  }, [project.cwd, closePreview]);

  useEffect(() => window.coilcoil.onFilePreviewUpdated((document) => {
    const selectedNode = selectedNodeRef.current;
    if (!selectedNode || !project.cwd) return;
    if (document.id !== previewIdRef.current && !samePreviewPath(project.cwd, selectedNode, document)) return;
    const previousId = previewIdRef.current;
    previewIdRef.current = document.id;
    if (previousId && previousId !== document.id) releasePreview(previousId);
    setSelection((current) => current && current.node.path === selectedNode.path
      ? { node: current.node, document, loading: false }
      : current);
  }), [project.cwd, releasePreview]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    releasePreview(previewIdRef.current);
  }, [releasePreview]);

  const loadDirectory = async (path: string): Promise<void> => {
    try {
      const children = runtimeId
        ? await window.coilcoil.request<FileNode[]>({ type: "list_directory", path }, runtimeId)
        : await window.coilcoil.listProjectDirectory(project.cwd, path);
      setTree((current) => replaceDirectoryChildren(current, path, children));
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openPreview = useCallback(async (node: FileNode, forceText = false): Promise<void> => {
    if (!project.cwd || node.kind !== "file") return;
    if (node.path !== selectedNodeRef.current?.path && blockedByUnsavedEdit()) return;
    const requestId = ++requestIdRef.current;
    selectedNodeRef.current = node;
    const previousId = previewIdRef.current;
    previewIdRef.current = undefined;
    releasePreview(previousId);
    setSelection({ node, loading: true });
    try {
      const result = await window.coilcoil.openFilePreview({ root: project.cwd, path: node.path, forceText });
      if (requestId !== requestIdRef.current) {
        releasePreview(result.document?.id);
        return;
      }
      if (result.document) {
        previewIdRef.current = result.document.id;
        setSelection({ node, document: result.document, loading: false });
        return;
      }
      setSelection({ node, loading: false, error: "此文件类型暂不支持直接预览，可从右键菜单选择其他打开方式。" });
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setSelection({ node, loading: false, error: caught instanceof Error ? caught.message : String(caught) });
    }
  }, [blockedByUnsavedEdit, project.cwd, releasePreview]);

  useEffect(() => {
    if (!activeFilePath) {
      if (selectedNodeRef.current) closePreview();
      return;
    }
    if (selectedNodeRef.current?.path === activeFilePath) return;
    const node = findFileNode(tree, activeFilePath) ?? previewFileNode(activeFilePath);
    void openPreview(node);
  }, [activeFilePath, closePreview, openPreview, tree]);

  const removeNode = (path: string): void => {
    setTree((current) => removeTreeNode(current, path));
    const selectedPath = selectedNodeRef.current?.path;
    if (selectedPath === path || selectedPath?.startsWith(`${path}/`) || selectedPath?.startsWith(`${path}\\`)) closePreview();
    onRemovePath?.(path);
  };

  if (!project.cwd) {
    return <div className="inspector-empty"><span className="inspector-empty-icon"><Files size={16} strokeWidth={1.7} /></span><strong>未打开项目</strong><p>打开项目后即可查看文件。</p></div>;
  }

  return (
    <div
      className={`files-workspace ${selection ? "has-preview" : ""}`}
      style={selection ? { gridTemplateColumns: `minmax(0, ${previewShare}fr) 7px minmax(0, ${1 - previewShare}fr)` } : undefined}
    >
      {selection ? (
        <FilePreviewPane
          preview={selection.document}
          root={project.cwd}
          loading={selection.loading}
          error={selection.error}
          onDirtyChange={(dirty) => { dirtyRef.current = dirty; }}
          onClose={() => {
            if (blockedByUnsavedEdit()) return;
            const path = selectedNodeRef.current?.path;
            closePreview();
            if (path) onCloseFile?.(path);
          }}
        />
      ) : null}
      {selection ? (
        <div
          className="files-split-resizer"
          role="separator"
          tabIndex={0}
          aria-label="调整文件预览与目录宽度"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(previewShare * 100)}
          onPointerDown={beginResize}
          onKeyDown={handleResizeKeyDown}
        />
      ) : null}
      <aside className="files-tree-region" aria-label="项目文件目录">
        <FileTree
          nodes={tree}
          root={project.cwd}
          selectedPath={selection?.node.path}
          onLoad={loadDirectory}
          onOpen={(node) => {
            onOpenFile?.(node);
            void openPreview(node);
          }}
          onOpenAsText={(node) => {
            onOpenFile?.(node);
            void openPreview(node, true);
          }}
          onTrashed={removeNode}
        />
      </aside>
    </div>
  );
}
