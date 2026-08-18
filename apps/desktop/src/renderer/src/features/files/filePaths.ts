import type { FileNode } from "@suocode/runtime-protocol";

export function absoluteProjectPath(root: string, value: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return value;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
}

export function relativeProjectPath(root: string, value: string): string {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedValue = value.replaceAll("\\", "/");
  if (normalizedValue === normalizedRoot) return ".";
  return normalizedValue.startsWith(`${normalizedRoot}/`)
    ? normalizedValue.slice(normalizedRoot.length + 1)
    : value;
}

export function previewFileNode(path: string): FileNode {
  const name = path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
  return { name, path, kind: "file" };
}

export function replaceDirectoryChildren(nodes: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === path && node.kind === "directory") return { ...node, children };
    if (!node.children) return node;
    return { ...node, children: replaceDirectoryChildren(node.children, path, children) };
  });
}

export function removeTreeNode(nodes: FileNode[], path: string): FileNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) => node.children ? { ...node, children: removeTreeNode(node.children, path) } : node);
}
