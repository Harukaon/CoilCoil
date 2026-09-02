import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { FilePreviewDocument, OpenFilePreviewInput, OpenFilePreviewResult } from "../shared/desktop-api";
import { editableState } from "./file-edit";

const TEXT_EXTENSIONS = new Set([
  "", ".txt", ".log", ".md", ".mdx", ".markdown", ".json", ".jsonc", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less",
  ".py", ".pyi", ".rb", ".php", ".java", ".kt", ".kts", ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1", ".sql", ".graphql", ".gql", ".env", ".ini", ".cfg", ".conf", ".properties",
  ".dockerfile", ".gitignore", ".gitattributes", ".editorconfig", ".html", ".htm", ".svg",
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const EMBEDDED_PREVIEW_LIMIT = 20 * 1024 * 1024;

/**
 * 谁在看这份预览，以及文件变了要把新内容送到哪里去。
 *
 * 桌面窗口是一份 WebContents，手机远程端不是——它在这台机器上没有自己的
 * WebContents，更新得沿着远程连接广播回去。预览本身两边完全一样（内容是主进程读
 * 出来直接放进返回值里的），差的只是这一条回程，所以把回程抽出来，远程就不必再被
 * 挡在门外。
 */
export interface PreviewOwner {
  /** 关预览时用来认人：只有开这份预览的人能关它。 */
  id: number;
  alive(): boolean;
  send(document: FilePreviewDocument): void;
  /** 这个人不在了（窗口关掉）时把预览一起收掉。 */
  onGone(handler: () => void): void;
}

/** 桌面窗口的那一份。 */
export function windowPreviewOwner(contents: Electron.WebContents): PreviewOwner {
  return {
    id: contents.id,
    alive: () => !contents.isDestroyed(),
    send: (document) => contents.send(PREVIEW_UPDATED_CHANNEL, document),
    onGone: (handler) => { contents.once("destroyed", handler); },
  };
}

export const PREVIEW_UPDATED_CHANNEL = "preview:updated";

interface PreviewRecord {
  id: string;
  path: string;
  forceText: boolean;
  owner: PreviewOwner;
  watcher?: FSWatcher;
  document?: FilePreviewDocument;
}

export interface SafePreviewPath {
  root: string;
  path: string;
}

export type PreviewPathResolver = (input: OpenFilePreviewInput) => Promise<SafePreviewPath>;

const previews = new Map<string, PreviewRecord>();

export function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()];
}

export function previewKind(path: string, forceText: boolean): FilePreviewDocument["kind"] | undefined {
  const extension = extname(path).toLowerCase();
  if (!forceText && extension === ".pdf") return "pdf";
  if (!forceText && imageMimeType(path)) return "image";
  if (!forceText && [".md", ".mdx", ".markdown"].includes(extension)) return "markdown";
  if (!forceText && [".html", ".htm"].includes(extension)) return "html";
  if (forceText || TEXT_EXTENSIONS.has(extension) || ["dockerfile", "makefile", "license", "readme"].includes(basename(path).toLowerCase())) return "text";
  return undefined;
}

async function readPreview(record: PreviewRecord): Promise<FilePreviewDocument> {
  const kind = previewKind(record.path, record.forceText);
  if (!kind) throw new Error("此文件类型暂不支持预览。");
  const [buffer, stats] = await Promise.all([readFile(record.path), stat(record.path)]);
  const limit = kind === "text" || kind === "markdown" || kind === "html" ? TEXT_PREVIEW_LIMIT : EMBEDDED_PREVIEW_LIMIT;
  if (kind === "image" && buffer.byteLength > limit) {
    throw new Error("图片超过 20 MB，暂不支持预览。");
  }
  const mimeType = kind === "image" ? imageMimeType(record.path) : undefined;
  if (kind === "image" && !mimeType) throw new Error("无法识别图片格式。");
  const truncated = buffer.byteLength > limit;
  const content = kind === "pdf"
    ? `data:application/pdf;base64,${buffer.subarray(0, limit).toString("base64")}`
    : kind === "image"
      ? `data:${mimeType};base64,${buffer.toString("base64")}`
      : buffer.subarray(0, limit).toString("utf8");
  return {
    id: record.id,
    path: record.path,
    name: basename(record.path),
    kind,
    content,
    truncated,
    updatedAt: Date.now(),
    mtimeMs: stats.mtimeMs,
    ...editableState(kind, buffer, truncated),
  };
}

function closePreviewRecord(id: string): void {
  const record = previews.get(id);
  if (!record) return;
  record.watcher?.close();
  previews.delete(id);
}

async function updatePreview(record: PreviewRecord): Promise<void> {
  try {
    record.document = await readPreview(record);
    if (!record.owner.alive()) {
      closePreviewRecord(record.id);
      return;
    }
    record.owner.send(record.document);
  } catch {
    // The file may be in the middle of an atomic replace; the next watch event retries it.
  }
}

async function createPreviewRecord(owner: PreviewOwner, input: OpenFilePreviewInput, resolvePath: PreviewPathResolver): Promise<FilePreviewDocument> {
  const target = await resolvePath(input);
  const id = randomUUID();
  const record: PreviewRecord = {
    id,
    path: target.path,
    forceText: Boolean(input.forceText),
    owner,
  };
  previews.set(id, record);
  try {
    record.document = await readPreview(record);
    record.watcher = watch(dirname(record.path), { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() === basename(record.path)) void updatePreview(record);
    });
    owner.onGone(() => closePreviewRecord(id));
    return record.document;
  } catch (error) {
    closePreviewRecord(id);
    throw error;
  }
}

export async function openFilePreview(
  owner: PreviewOwner,
  input: OpenFilePreviewInput,
  resolvePath: PreviewPathResolver,
): Promise<OpenFilePreviewResult> {
  const target = await resolvePath(input);
  if (previewKind(target.path, Boolean(input.forceText))) {
    return { opened: true, document: await createPreviewRecord(owner, input, resolvePath) };
  }
  return { opened: false, actions: ["reveal", "force-text", "trash"] };
}

export function closeFilePreview(ownerId: number, id: string): void {
  const record = previews.get(id);
  if (!record || record.owner.id !== ownerId) return;
  closePreviewRecord(id);
}

export function closeAllFilePreviews(): void {
  for (const id of [...previews.keys()]) closePreviewRecord(id);
}
