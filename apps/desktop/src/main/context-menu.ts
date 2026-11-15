import {
  app, BrowserWindow, Menu, MenuItem, clipboard,
  type ContextMenuParams,
  type WebContents,
} from "electron";
import { isSafeExternalHttpUrl, openExternalSafely } from "./external-url";
import {
  CONTEXT_MENU_COMMAND_CHANNEL,
  CONTEXT_MENU_REQUEST_CHANNEL,
  isOfferedCommand,
  parseContextMenuCommand,
  type ContextMenuCommand,
  type ContextMenuRequest,
} from "../shared/context-menu";

// Electron ships with no default right-click menu. The app draws every menu
// in the renderer, in the app's own language and look: object menus (an
// issue, a comment, a project) handle the DOM `contextmenu` event and
// preventDefault it, which keeps Electron from firing `context-menu` at all.
// What reaches this handler is the content layer the page left alone — text
// fields, selected text, links, images, code, tables, attachments — and main
// forwards every one to the renderer, which adds what only the page knows
// (the code, the comment around it) and skips a menu with nothing in it.
export function installContextMenu(webContents: WebContents): void {
  // The latest right-click and the params it came with. A command answers
  // only this one, once; anything older or repeated is dropped.
  let pending: { request: ContextMenuRequest; params: ContextMenuParams } | null = null;
  let nextId = 0;

  webContents.on("context-menu", (_event, params) => {
    nextId += 1;
    const request = buildContextMenuRequest(nextId, params);
    pending = { request, params };
    webContents.send(CONTEXT_MENU_REQUEST_CHANNEL, request);
  });

  webContents.ipc.on(CONTEXT_MENU_COMMAND_CHANNEL, (_event, raw: unknown) => {
    const command = parseContextMenuCommand(raw);
    if (!command || !pending || !isOfferedCommand(pending.request, command)) return;
    const { params } = pending;
    pending = null;
    runCommand(webContents, params, command);
  });
}

export function showLocalFileContextMenu(
  webContents: WebContents,
  input: { hasSelection: boolean },
  // A file on another device can be saved here but not shown in a folder.
  actions: { copyPath(): Promise<void>; reveal?(): Promise<void>; saveToThisDevice?(): Promise<void> },
): void {
  const labels = pickLabels();
  const menu = new Menu();
  if (input.hasSelection) {
    menu.append(new MenuItem({ role: "copy" }));
    menu.append(new MenuItem({ type: "separator" }));
  }
  const run = (action: () => Promise<void>) => {
    void action().catch((error: unknown) => console.warn("[context-menu] local file action failed", error));
  };
  menu.append(new MenuItem({ label: labels.copyPath, click: () => run(actions.copyPath) }));
  if (actions.reveal) menu.append(new MenuItem({ label: process.platform === "darwin" ? labels.openInFinder : labels.showInFolder, click: () => run(actions.reveal!) }));
  if (actions.saveToThisDevice) menu.append(new MenuItem({ label: labels.saveToThisDevice, click: () => run(actions.saveToThisDevice!) }));
  menu.popup({ window: BrowserWindow.fromWebContents(webContents) ?? undefined });
}

// Labels for the custom menu items in the user's OS-preferred language,
// with English as the fallback. Kept inline because the main process has
// no shared i18n loader (the renderer's i18next is per-window and not
// reachable from here), and pulling one in for a few menu labels would be
// more rope than payload. Matches the four locales the renderer ships.
type ContextMenuLabels = {
  copyPath: string;
  saveToThisDevice: string;
  openInFinder: string;
  showInFolder: string;
  openLink: string;
  copyLinkAddress: string;
  copyImage: string;
  addToDictionary: string;
};

const labelsByLocale: Record<string, ContextMenuLabels> = {
  en: {
    copyPath: "Copy Path",
    saveToThisDevice: "Save to This Device",
    openInFinder: "Open in Finder",
    showInFolder: "Show in Folder",
    openLink: "Open Link in Browser",
    copyLinkAddress: "Copy Link Address",
    copyImage: "Copy Image",
    addToDictionary: "Add to Dictionary",
  },
  "zh-Hans": {
    copyPath: "复制路径",
    saveToThisDevice: "保存到本机",
    openInFinder: "在 Finder 中显示",
    showInFolder: "在文件夹中显示",
    openLink: "在浏览器中打开链接",
    copyLinkAddress: "复制链接地址",
    copyImage: "复制图片",
    addToDictionary: "添加到词典",
  },
  "zh-Hant": {
    copyPath: "複製路徑",
    saveToThisDevice: "儲存到本機",
    openInFinder: "在 Finder 中顯示",
    showInFolder: "在資料夾中顯示",
    openLink: "在瀏覽器中開啟連結",
    copyLinkAddress: "複製連結網址",
    copyImage: "複製圖片",
    addToDictionary: "加入字典",
  },
  ja: {
    copyPath: "パスをコピー",
    saveToThisDevice: "このデバイスに保存",
    openInFinder: "Finder で表示",
    showInFolder: "フォルダーに表示",
    openLink: "ブラウザでリンクを開く",
    copyLinkAddress: "リンクのアドレスをコピー",
    copyImage: "画像をコピー",
    addToDictionary: "辞書に追加",
  },
  ko: {
    copyPath: "경로 복사",
    saveToThisDevice: "이 기기에 저장",
    openInFinder: "Finder에서 보기",
    showInFolder: "폴더에서 보기",
    openLink: "브라우저에서 링크 열기",
    copyLinkAddress: "링크 주소 복사",
    copyImage: "이미지 복사",
    addToDictionary: "사전에 추가",
  },
};

// pickLabels resolves the OS-preferred language to one of the four
// locales we ship copy for. We say "Open Link in Browser" rather than
// "Open Link in New Window" because the link is opened via
// shell.openExternal — it lands in the user's default browser, not in
// another Multica window — so the wording matches what actually
// happens.
function pickLabels(): ContextMenuLabels {
  const preferred = app.getPreferredSystemLanguages()[0]?.toLowerCase() ?? "";
  if (preferred.startsWith("zh")) {
    // Traditional-script and Taiwan/Hong Kong/Macau tags get zh-Hant; every
    // other Chinese variant gets the Simplified copy.
    return /^zh-(hant|tw|hk|mo)\b/.test(preferred)
      ? labelsByLocale["zh-Hant"]
      : labelsByLocale["zh-Hans"];
  }
  if (preferred.startsWith("ja")) return labelsByLocale.ja;
  if (preferred.startsWith("ko")) return labelsByLocale.ko;
  return labelsByLocale.en;
}

export function buildContextMenuRequest(
  id: number,
  params: ContextMenuParams,
): ContextMenuRequest {
  const { editFlags, isEditable, misspelledWord } = params;
  const hasSelection = params.selectionText.trim().length > 0;
  const spelling = isEditable && !!misspelledWord;
  return {
    id,
    x: params.x,
    y: params.y,
    isEditable,
    canCut: isEditable && editFlags.canCut,
    canCopy: hasSelection && editFlags.canCopy,
    canPaste: isEditable && editFlags.canPaste,
    canSelectAll: isEditable && editFlags.canSelectAll,
    suggestions: spelling ? [...params.dictionarySuggestions] : [],
    canAddToDictionary: spelling,
    // params.linkURL is the resolved absolute URL of the anchor under the
    // cursor. Only http(s) links are offered: other schemes (mailto:,
    // javascript:, the app's own file:// routes) would route through the OS
    // handler, which is outside what this menu promises.
    hasLink: !!params.linkURL && isSafeExternalHttpUrl(params.linkURL),
    // Copies the decoded bitmap Chromium already holds, so it needs pixels.
    hasImage: params.mediaType === "image" && params.hasImageContents,
  };
}

function runCommand(
  webContents: WebContents,
  params: ContextMenuParams,
  command: ContextMenuCommand,
): void {
  switch (command.type) {
    case "cut":
      webContents.cut();
      return;
    case "copy":
      webContents.copy();
      return;
    case "paste":
      webContents.paste();
      return;
    case "selectAll":
      webContents.selectAll();
      return;
    case "replaceMisspelling": {
      const suggestion = params.dictionarySuggestions[command.index];
      if (suggestion !== undefined) webContents.replaceMisspelling(suggestion);
      return;
    }
    case "addToDictionary":
      webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
      return;
    case "openLink":
      // openExternalSafely re-validates the scheme.
      void openExternalSafely(params.linkURL);
      return;
    case "copyLink":
      // Electron 44 made clipboard writes async; catch so a failed write
      // can't surface as an unhandled rejection in the main process.
      clipboard.writeText(params.linkURL).catch((err: unknown) => {
        console.warn("[context-menu] copy link address failed", err);
      });
      return;
    case "copyImage":
      webContents.copyImageAt(params.x, params.y);
      return;
  }
}
