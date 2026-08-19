/**
 * The right-click menu for the built-in browser's `<webview>` guests.
 *
 * Electron ships no default context menu, so without this a right-click inside
 * a guest page does nothing at all — no copy, no paste, no "copy link address".
 * Chromium still raises the `context-menu` event with everything needed to build
 * one, so main assembles the menu itself.
 *
 * The item list is a pure function of the event payload so the menu can be
 * tested without launching Electron; only `installGuestContextMenu` touches
 * Electron's `Menu`.
 */

export type ContextMenuAction =
  | "back"
  | "forward"
  | "reload"
  | "copyLinkUrl"
  | "copyImageUrl"
  | "copyImage"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "copyPageUrl"
  | "inspect";

export interface ContextMenuItem {
  action?: ContextMenuAction;
  label?: string;
  type?: "separator";
  enabled?: boolean;
}

/** The subset of Electron's `ContextMenuParams` the menu is built from. */
export interface GuestContextMenuParams {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  pageURL: string;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

export interface GuestNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

function separate(groups: ContextMenuItem[][]): ContextMenuItem[] {
  const filled = groups.filter((group) => group.length > 0);
  return filled.flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

/**
 * Build the menu for one right-click.
 *
 * Items are grouped by what was clicked — link, image, selection, editable
 * field — and only the groups that apply are emitted, so a right-click on bare
 * page background still offers navigation and inspection rather than an empty
 * menu.
 */
export function browserContextMenuItems(
  params: GuestContextMenuParams,
  navigation: GuestNavigationState,
): ContextMenuItem[] {
  const link: ContextMenuItem[] = params.linkURL
    ? [{ action: "copyLinkUrl", label: "复制链接地址", enabled: true }]
    : [];
  const image: ContextMenuItem[] = params.mediaType === "image" && params.srcURL
    ? [
      { action: "copyImage", label: "复制图片", enabled: true },
      { action: "copyImageUrl", label: "复制图片地址", enabled: true },
    ]
    : [];
  const edit: ContextMenuItem[] = [];
  if (params.isEditable) {
    edit.push({ action: "cut", label: "剪切", enabled: params.editFlags.canCut });
    edit.push({ action: "copy", label: "复制", enabled: params.editFlags.canCopy });
    edit.push({ action: "paste", label: "粘贴", enabled: params.editFlags.canPaste });
    edit.push({ action: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll });
  } else if (params.selectionText.trim()) {
    edit.push({ action: "copy", label: "复制", enabled: params.editFlags.canCopy });
  }
  const navigate: ContextMenuItem[] = [
    { action: "back", label: "后退", enabled: navigation.canGoBack },
    { action: "forward", label: "前进", enabled: navigation.canGoForward },
    { action: "reload", label: "重新加载", enabled: true },
  ];
  const page: ContextMenuItem[] = [
    { action: "copyPageUrl", label: "复制页面地址", enabled: Boolean(params.pageURL) },
    { action: "inspect", label: "检查元素", enabled: true },
  ];
  return separate([link, image, edit, navigate, page]);
}

interface GuestContextMenuHost {
  copyToClipboard(text: string): void;
  copyImageAt(x: number, y: number): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  inspectElement(x: number, y: number): void;
}

/** Run one menu selection against the guest it was raised on. */
export function runContextMenuAction(
  action: ContextMenuAction,
  params: GuestContextMenuParams,
  host: GuestContextMenuHost,
): void {
  switch (action) {
    case "copyLinkUrl": return host.copyToClipboard(params.linkURL);
    case "copyImageUrl": return host.copyToClipboard(params.srcURL);
    case "copyPageUrl": return host.copyToClipboard(params.pageURL);
    case "copyImage": return host.copyImageAt(params.x, params.y);
    case "cut": return host.cut();
    case "copy": return host.copy();
    case "paste": return host.paste();
    case "selectAll": return host.selectAll();
    case "back": return host.goBack();
    case "forward": return host.goForward();
    case "reload": return host.reload();
    case "inspect": return host.inspectElement(params.x, params.y);
  }
}
