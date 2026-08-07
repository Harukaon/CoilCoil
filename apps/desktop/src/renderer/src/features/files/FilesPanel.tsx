import { ChevronDown, ChevronRight, File, Files, Folder, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { FileNode, ProjectSnapshot } from "@suocode/runtime-protocol";

function absoluteProjectPath(root: string, value: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return value;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
}

function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceDirectoryChildren(nodes: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === path && node.kind === "directory") return { ...node, children };
    if (!node.children) return node;
    return { ...node, children: replaceDirectoryChildren(node.children, path, children) };
  });
}

function FileTreeNode({ node, root, depth, onLoad, onOpen }: {
  node: FileNode;
  root: string;
  depth: number;
  onLoad: (path: string) => Promise<void>;
  onOpen: (node: FileNode) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const startPathDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const absolutePath = absoluteProjectPath(root, node.path);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-suocode-path", JSON.stringify({ path: absolutePath }));
    event.dataTransfer.setData("text/plain", quotePath(absolutePath));
  };

  if (node.kind === "directory") {
    const toggle = async (): Promise<void> => {
      const nextOpen = !open;
      setOpen(nextOpen);
      if (nextOpen && node.children === undefined && !loading) {
        setLoading(true);
        try {
          await onLoad(node.path);
        } finally {
          setLoading(false);
        }
      }
    };
    return (
      <div className="file-tree-node">
        <button type="button" draggable style={{ paddingLeft: 8 + depth * 13 }} onClick={() => void toggle()} onDragStart={startPathDrag}>
          {loading ? <LoaderCircle className="spin" size={12} /> : open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={14} />
          <span>{node.name}</span>
        </button>
        {open ? node.children?.map((child) => <FileTreeNode key={child.path} node={child} root={root} depth={depth + 1} onLoad={onLoad} onOpen={onOpen} />) : null}
      </div>
    );
  }
  return (
    <button className="file-leaf" type="button" draggable style={{ paddingLeft: 21 + depth * 13 }} onClick={() => onOpen(node)} onDragStart={startPathDrag}>
      <File size={13} /><span>{node.name}</span>
    </button>
  );
}

export function FilesPanel({ project, runtimeId, onOpen }: { project: ProjectSnapshot; runtimeId?: string; onOpen: (node: FileNode) => void }): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>(project.files);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTree(project.files);
    setError(undefined);
    if (!project.cwd || project.files.length) return;
    void window.suocode.listProjectDirectory(project.cwd).then(setTree).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [project.cwd, project.files]);

  const loadDirectory = async (path: string): Promise<void> => {
    try {
      const children = runtimeId
        ? await window.suocode.request<FileNode[]>({ type: "list_directory", path }, runtimeId)
        : await window.suocode.listProjectDirectory(project.cwd, path);
      setTree((current) => replaceDirectoryChildren(current, path, children));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  if (!project.cwd) {
    return <div className="inspector-empty"><span className="inspector-empty-icon"><Files size={16} strokeWidth={1.7} /></span><strong>未打开项目</strong><p>打开项目后即可查看文件。</p></div>;
  }
  return (
    <div className="files-panel">
      <div className="file-tree">
        {tree.length ? tree.map((node) => <FileTreeNode key={node.path} node={node} root={project.cwd} depth={0} onLoad={loadDirectory} onOpen={onOpen} />) : <p className="panel-note">此文件夹为空。</p>}
        {error ? <p className="file-tree-error">{error}</p> : null}
      </div>
    </div>
  );
}
