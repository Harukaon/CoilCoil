import type { FilePreviewDocument } from "../../../../shared/desktop-api";
import { insideProject } from "./filePaths";

/** One open editing session: what was loaded, and what the user has typed since. */
export interface EditSession {
  /** The file's text when editing started — the version a save is based on. */
  baseContent: string;
  baseMtimeMs: number;
  draft: string;
}

export interface EditAvailability {
  canEdit: boolean;
  /** Why this document cannot be edited, when the reason is worth showing. */
  reason?: string;
}

/**
 * Editing is offered only for a text document the workspace owns.
 *
 * Preview deliberately opens any path an agent cites, including files outside
 * the project; writing to those is refused by the main process, so the button is
 * not offered for them either — a disabled reason beats a save that fails.
 */
export function editAvailability(document: FilePreviewDocument | undefined, root: string | undefined): EditAvailability {
  if (!document || !root) return { canEdit: false };
  if (!document.editable) {
    return document.readOnlyReason ? { canEdit: false, reason: document.readOnlyReason } : { canEdit: false };
  }
  if (!insideProject(root, document.path)) return { canEdit: false, reason: "文件不在当前项目内，只能查看。" };
  return { canEdit: true };
}

export function beginEdit(document: FilePreviewDocument): EditSession {
  return { baseContent: document.content, baseMtimeMs: document.mtimeMs, draft: document.content };
}

export function isDirty(session: EditSession | undefined): boolean {
  return Boolean(session && session.draft !== session.baseContent);
}

/**
 * The file changed on disk while it was being edited — the agent rewriting the
 * very file the user opened is the ordinary case, not a rare one. The watcher's
 * document is compared by content rather than by timestamp so that a touched but
 * unchanged file raises nothing.
 */
export function hasExternalChange(session: EditSession | undefined, document: FilePreviewDocument | undefined): boolean {
  return Boolean(session && document && document.content !== session.baseContent);
}

/**
 * Move the session onto the version now on disk. `keepDraft` is the user's
 * choice between the two: keeping it means the next save overwrites the outside
 * change on purpose, dropping it reloads what the other writer produced.
 */
export function rebaseEdit(session: EditSession, document: FilePreviewDocument, keepDraft: boolean): EditSession {
  return {
    baseContent: document.content,
    baseMtimeMs: document.mtimeMs,
    draft: keepDraft ? session.draft : document.content,
  };
}
