import * as ContextMenu from "@radix-ui/react-context-menu";
import { ChevronDown, ChevronRight, File, Folder, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { FileNode } from "@suocode/runtime-protocol";
import { fileManagerLabel, trashLabel } from "../../../../shared/platform-labels";
import { toastError } from "../../ui/toast";
import { quotePath, SUOCODE_PATH_TYPE } from "../composer/pathInsert";
import { absoluteProjectPath, relativeProjectPath } from "./filePaths";

function FileContextMenu({ node, root, onOpenAsText, onTrashed }: {
  node: FileNode;
  root: string;
  onOpenAsText: (node: FileNode) => void;
  onTrashed: (path: string) => void;
}): React.JSX.Element {
  const copy = async (value: string): Promise<void> => {
    try {
      await window.suocode.copyText(value);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const run = async (action: "reveal" | "trash"): Promise<void> => {
    try {
      const result = await window.suocode.performProjectFileAction({ root, path: node.path, action });
      if (result.trashed) onTrashed(node.path);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className="conversation-context-menu" collisionPadding={8}>
        <ContextMenu.Item className="conversation-context-item" onSelect={() => void copy(absoluteProjectPath(root, node.path))}>复制绝对路径</ContextMenu.Item>
        <ContextMenu.Item className="conversation-context-item" onSelect={() => void copy(relativeProjectPath(root, node.path))}>复制相对路径</ContextMenu.Item>
        <ContextMenu.Separator className="file-context-separator" />
        {node.kind === "file" ? <ContextMenu.Item className="conversation-context-item" onSelect={() => onOpenAsText(node)}>作为文本尝试预览</ContextMenu.Item> : null}
        {node.kind === "file" ? <ContextMenu.Separator className="file-context-separator" /> : null}
        <ContextMenu.Item className="conversation-context-item" onSelect={() => void run("reveal")}>在{fileManagerLabel(window.suocode.platform)}中显示</ContextMenu.Item>
        <ContextMenu.Separator className="file-context-separator" />
        <ContextMenu.Item className="conversation-context-item file-context-danger" onSelect={() => void run("trash")}>移到{trashLabel(window.suocode.platform)}</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function FileTreeNode({ node, root, depth, selectedPath, onLoad, onOpen, onOpenAsText, onTrashed }: {
  node: FileNode;
  root: string;
  depth: number;
  selectedPath?: string;
  onLoad: (path: string) => Promise<void>;
  onOpen: (node: FileNode) => void;
  onOpenAsText: (node: FileNode) => void;
  onTrashed: (path: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const startPathDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const absolutePath = absoluteProjectPath(root, node.path);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(SUOCODE_PATH_TYPE, JSON.stringify({ path: absolutePath }));
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
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <button type="button" draggable style={{ paddingLeft: 8 + depth * 13 }} onClick={() => void toggle()} onDragStart={startPathDrag}>
              {loading ? <LoaderCircle className="spin" size={12} /> : open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Folder size={14} />
              <span>{node.name}</span>
            </button>
          </ContextMenu.Trigger>
          <FileContextMenu node={node} root={root} onOpenAsText={onOpenAsText} onTrashed={onTrashed} />
        </ContextMenu.Root>
        {open ? node.children?.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            root={root}
            depth={depth + 1}
            selectedPath={selectedPath}
            onLoad={onLoad}
            onOpen={onOpen}
            onOpenAsText={onOpenAsText}
            onTrashed={onTrashed}
          />
        )) : null}
      </div>
    );
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          className={`file-leaf ${selectedPath === node.path ? "active" : ""}`}
          type="button"
          draggable
          style={{ paddingLeft: 21 + depth * 13 }}
          onClick={() => onOpen(node)}
          onDragStart={startPathDrag}
        >
          <File size={13} /><span>{node.name}</span>
        </button>
      </ContextMenu.Trigger>
      <FileContextMenu node={node} root={root} onOpenAsText={onOpenAsText} onTrashed={onTrashed} />
    </ContextMenu.Root>
  );
}

export function FileTree({ nodes, root, selectedPath, onLoad, onOpen, onOpenAsText, onTrashed }: {
  nodes: FileNode[];
  root: string;
  selectedPath?: string;
  onLoad: (path: string) => Promise<void>;
  onOpen: (node: FileNode) => void;
  onOpenAsText: (node: FileNode) => void;
  onTrashed: (path: string) => void;
}): React.JSX.Element {
  return (
    <div className="file-tree">
      {nodes.length ? nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          root={root}
          depth={0}
          selectedPath={selectedPath}
          onLoad={onLoad}
          onOpen={onOpen}
          onOpenAsText={onOpenAsText}
          onTrashed={onTrashed}
        />
      )) : <p className="panel-note">此文件夹为空。</p>}
    </div>
  );
}
