import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { FilePreviewDocument, OpenFilePreviewInput, OpenFilePreviewResult } from "../shared/desktop-api";

const TEXT_EXTENSIONS = new Set([
  "", ".txt", ".log", ".md", ".mdx", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less",
  ".py", ".pyi", ".rb", ".php", ".java", ".kt", ".kts", ".go", ".rs", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1", ".sql", ".graphql", ".gql", ".env", ".ini", ".conf",
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

interface PreviewRecord {
  id: string;
  path: string;
  forceText: boolean;
  owner: Electron.WebContents;
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
  const buffer = await readFile(record.path);
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
  return { id: record.id, path: record.path, name: basename(record.path), kind, content, truncated, updatedAt: Date.now() };
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
    if (record.owner.isDestroyed()) {
      closePreviewRecord(record.id);
      return;
    }
    record.owner.send("preview:updated", record.document);
  } catch {
    // The file may be in the middle of an atomic replace; the next watch event retries it.
  }
}

async function createPreviewRecord(event: Electron.IpcMainInvokeEvent, input: OpenFilePreviewInput, resolvePath: PreviewPathResolver): Promise<FilePreviewDocument> {
  const target = await resolvePath(input);
  const id = randomUUID();
  const record: PreviewRecord = {
    id,
    path: target.path,
    forceText: Boolean(input.forceText),
    owner: event.sender,
  };
  previews.set(id, record);
  try {
    record.document = await readPreview(record);
    record.watcher = watch(dirname(record.path), { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() === basename(record.path)) void updatePreview(record);
    });
    event.sender.once("destroyed", () => closePreviewRecord(id));
    return record.document;
  } catch (error) {
    closePreviewRecord(id);
    throw error;
  }
}

export async function openFilePreview(
  event: Electron.IpcMainInvokeEvent,
  input: OpenFilePreviewInput,
  resolvePath: PreviewPathResolver,
): Promise<OpenFilePreviewResult> {
  const target = await resolvePath(input);
  if (previewKind(target.path, Boolean(input.forceText))) {
    return { opened: true, document: await createPreviewRecord(event, input, resolvePath) };
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
