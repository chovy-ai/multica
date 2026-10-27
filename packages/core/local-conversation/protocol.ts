import type { RuntimeModel } from "../types";

export const LOCAL_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type LocalReasoningEffort = typeof LOCAL_REASONING_EFFORTS[number];
export function isLocalReasoningEffort(value: unknown): value is LocalReasoningEffort {
  return LOCAL_REASONING_EFFORTS.some((effort) => effort === value);
}
export function localReasoningLevels(models: RuntimeModel[], model: string | null | undefined) {
  return models.find((entry) => model ? entry.id === model : entry.default)?.thinking?.supported_levels ?? [];
}
export type LocalProviderId = "codex" | "claude";
export const LOCAL_PERMISSION_MODES = ["default", "auto", "full-access"] as const;
export type LocalPermissionMode = typeof LOCAL_PERMISSION_MODES[number];
export function isLocalPermissionMode(value: unknown): value is LocalPermissionMode {
  return LOCAL_PERMISSION_MODES.some((mode) => mode === value);
}
export const CREATE_TASK_MENTION_ID = "multica:create-task";
export function isTaskCreationReference(value: { kind?: unknown; id?: unknown }): boolean {
  return value.kind === "issue" && value.id === CREATE_TASK_MENTION_ID;
}
export interface LocalConversationScope { userId: string; workspaceId: string }
export interface LocalFolderProject { id: string; title: string; path: string; createdAt: string }
export interface LocalProvider { id: LocalProviderId; name: string; available: boolean }
export interface LocalConversationEvent {
  seq: number; type: "text" | "thinking" | "tool_use" | "tool_result" | "status" | "error";
  content?: string; tool?: string; input?: Record<string, unknown>; output?: string; call_id?: string; created_at: string;
}
export interface LocalBackgroundTask {
  id: string; description: string; status: "running" | "completed" | "failed" | "cancelled";
  ambient?: boolean; summary?: string; createdAt?: string;
  toolUseId?: string; taskType?: string; progressSummary?: string; lastToolName?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  output?: string; outputTruncated?: boolean; updatedAt?: string; completedAt?: string;
}
export interface LocalConversationTurn {
  backgroundTasks?: LocalBackgroundTask[];
  questions?: LocalUserQuestion[];
  requestId?: string;
  id: string; status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string; completedAt?: string; error?: string; events: LocalConversationEvent[];
  remote?: { agentId: string; agentName: string; sessionId?: string; taskId?: string; queueOwned?: boolean };
}
export interface LocalUserQuestionInput {
  request_id: string;
  questions: { id: string; header?: string; question: string; options: { label: string; description?: string }[]; multiSelect: boolean; allowFreeText: boolean }[];
}
export interface LocalUserQuestion extends LocalUserQuestionInput {
  status: "pending" | "answered" | "cancelled";
  createdAt: string;
  updatedAt: string;
  answers?: Record<string, string | string[]>;
}
export interface LocalUserQuestionResult { answersByQuestionId: Record<string, string | string[]> }
export interface LocalConversationMessage { id: string; role: "user" | "assistant"; content: string; turnId: string; createdAt: string; failed?: boolean; attachmentIds?: string[] }
/** Keep internal image prompt markers out of displayed history and previews. */
export function localMessageDisplayContent(message?: Pick<LocalConversationMessage, "role" | "content" | "attachmentIds">): string {
  if (!message) return "";
  if (message.role !== "user" || !message.attachmentIds?.length) return message.content;
  const content = message.content.replace(/(^|\n\n)\[Image attachment: [^\r\n]*\](?=\n\n|$)/g, "");
  return content === message.content ? content : content.replace(/^\n\n/, "");
}
export interface LocalConversation {
  promptQueue?: LocalPromptQueue;
  side?: { sourceId: string; turnId?: string; quote?: string; requestId: string; context: { role: string; content: string }[]; pending?: LocalSidePrompt };
  id: string; title: string; provider: LocalProviderId; cwd: string; pinned: boolean;
  titleMode?: "auto" | "manual";
  titleGeneration?: "pending" | "complete" | "failed";
  archived: boolean; model: string | null; reasoningEffort?: LocalReasoningEffort | null; permissionMode?: LocalPermissionMode; providerSessionId?: string;
  forkedFrom?: string;
  importedFrom?: { provider: LocalProviderId; sessionId: string };
  forkedFromTurnId?: string;
  forkedTurnId?: string;
  forkMode?: "native" | "saved-context";
  forkRequestId?: string;
  projectId?: string | null;
  createdAt: string; updatedAt: string; messages: LocalConversationMessage[]; turns: LocalConversationTurn[];
}
export interface LocalImportCandidate {
  id: string; provider: LocalProviderId; title: string; cwd: string;
  createdAt: string; updatedAt: string; importedId?: string;
}
export interface LocalImportPage { sessions: LocalImportCandidate[]; nextCursor: string | null }
export interface LocalImportResult {
  imported: { sourceId: string; conversationId: string }[];
  skipped: { sourceId: string; conversationId: string }[];
  failed: { sourceId: string; error: string }[];
}
export interface LocalConversationModels { supported: boolean; models: RuntimeModel[] }
export interface LocalSidePrompt { content: string; attachmentIds?: string[]; references?: { kind: "session" | "issue" | "agent"; id: string }[]; model?: string; reasoningEffort?: LocalReasoningEffort | null; permissionMode?: LocalPermissionMode; requestId: string }
export interface LocalQueuedPrompt extends LocalSidePrompt {
  prompt?: string;
  display: LocalQueueDisplayPrompt;
  agents?: { id: string; name: string }[];
}
/** Serializable composer data; the main process has no GUI engine dependency. */
export interface LocalQueueDisplayPrompt {
  id: string;
  clientSubmitId?: string;
  createdAtUnixMs: number;
  displayPrompt?: string;
  content: readonly LocalPromptBlock[];
  runtimeContent?: readonly LocalPromptBlock[];
  requiredSettingsPatch?: { browserUse?: boolean; computerUse?: boolean };
}
export interface LocalPromptBlock {
  type: "text" | "image" | "file" | "skill" | "mention" | "connector";
  text?: string; mimeType?: string; data?: string; url?: string; attachmentId?: string;
  name?: string; path?: string; connectorKey?: string; uri?: string; hostPath?: string;
  uploadStatus?: string; assetId?: string; kind?: string; sizeBytes?: number;
}
export interface LocalPromptQueue {
  revision: number;
  paused: boolean;
  dispatchingRequestId?: string;
  error?: string;
  items: LocalQueuedPrompt[];
}
export interface LocalPreviewLocation { root: string; path: string; name: string; kind: "directory" | "file" }
/**
 * A previewable file. The host returns `fileRef`, a short-lived grant for the
 * HTTP file endpoint; Desktop fills `url` (images, PDF) or `text` from it.
 */
export interface LocalPreviewFile { name: string; path: string; root?: string; mimeType: string; size: number; fileRef?: string; url?: string; text?: string; truncated: boolean }
export interface LocalContextUsage {
  usedTokens: number | null; limitTokens: number | null; model: string | null; updatedAt: string | null;
}
export interface LocalUsageWindow {
  id: string; label: string; usedPercent: number; resetsAt: string | null;
}
export interface LocalAccountUsage {
  status: "available" | "unavailable" | "error"; plan: string | null;
  windows: LocalUsageWindow[]; updatedAt: string | null; stale?: boolean;
}
export interface LocalProviderUsage {
  provider: LocalProviderId; context: LocalContextUsage; account: LocalAccountUsage;
}
export const LOCAL_CONVERSATION_PROTOCOL_VERSION = 2;
export interface LocalConversationCapabilities { protocolVersion: number; methods: string[] }
export interface LocalConversationMethods {
  capabilities: { params: Record<string, never>; result: LocalConversationCapabilities };
  queueEnqueue: { params: { id: string; item: LocalQueuedPrompt; paused?: boolean }; result: LocalPromptQueue };
  queueUpdate: { params: { id: string; action: "pause" | "stop" | "resume" | "remove" | "sendNow"; requestId?: string }; result: LocalPromptQueue };
  queueSide: { params: { id: string; requestId: string }; result: LocalConversation };
  stopBackgroundTasks: { params: { id: string }; result: void };
  folderProjects: { params: Record<string, never>; result: LocalFolderProject[] };
  folderProjectAdd: { params: Record<string, never>; result: LocalFolderProject | null };
  sideCreate: { params: { id: string; turnId?: string; quote?: string; requestId: string; pending?: LocalSidePrompt; queuedPrompt?: LocalQueuedPrompt }; result: LocalConversation };
  sideAccepted: { params: { id: string; requestId: string }; result: void };
  previewChoose: { params: { kind: "file" | "directory" }; result: LocalPreviewLocation | null };
  previewList: { params: { root: string; path: string; id?: string }; result: LocalPreviewLocation[] };
  previewRead: { params: { root?: string; path: string; id?: string }; result: LocalPreviewFile };
  importScan: { params: { provider: LocalProviderId; cursor?: string }; result: LocalImportPage };
  importSessions: { params: { provider: LocalProviderId; ids: string[]; projectId?: string | null }; result: LocalImportResult };
  importCancel: { params: Record<string, never>; result: void };
  providers: { params: Record<string, never>; result: LocalProvider[] };
  list: { params: Record<string, never>; result: LocalConversation[] };
  read: { params: { id: string }; result: LocalConversation };
  create: { params: { provider: LocalProviderId; title?: string; projectId?: string | null; folderProjectId?: string | null; directorySourceId?: string }; result: LocalConversation };
  fork: { params: { id: string; turnId?: string; requestId?: string }; result: LocalConversation };
  update: { params: { id: string; title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null }; result: LocalConversation };
  directory: { params: { id: string }; result: LocalConversation };
  send: { params: { id: string; content: string; prompt?: string; references?: { kind: "session" | "issue" | "agent"; id: string }[]; attachmentIds?: string[]; model?: string; reasoningEffort?: LocalReasoningEffort | null; permissionMode?: LocalPermissionMode; requestId?: string }; result: { messageId: string; turnId: string; createdAt: string; replayed?: boolean } };
  fileStore: { params: { name: string; mimeType: string; data: string }; result: { id: string } };
  fileInfo: { params: { id: string }; result: { name: string; mimeType: string; path: string; url: string; size: number } };
  fileRead: { params: { id: string }; result: { name: string; mimeType: string; data: string; path: string; size: number } };
  imageRead: { params: { id: string; path: string }; result: LocalPreviewFile };
  cancel: { params: { id: string; turnId: string }; result: LocalConversationTurn };
  answerQuestion: { params: { id: string; turnId: string; requestId: string; answers: Record<string, string | string[]> }; result: void };
  models: { params: { provider: LocalProviderId; force?: boolean }; result: LocalConversationModels };
  usage: { params: { provider: LocalProviderId; id?: string; force?: boolean }; result: LocalProviderUsage };
  remoteBegin: { params: { id: string; content: string; agents: { id: string; name: string }[]; attachmentIds?: string[]; requestId?: string }; result: { messageId: string; turns: LocalConversationTurn[]; createdAt: string; replayed?: boolean } };
  /** Starts cloud agent turns; the host sends, polls and resumes them. */
  remoteSend: { params: { id: string; content: string; prompt?: string; agents: { id: string; name: string }[]; attachmentIds?: string[]; requestId?: string }; result: { messageId: string; turns: LocalConversationTurn[]; createdAt: string; replayed?: boolean } };
  remoteUpdate: { params: { id: string; turnId: string; sessionId?: string; taskId?: string; events?: LocalConversationEvent[]; output?: string; error?: string; status?: LocalConversationTurn["status"] }; result: void };
}
export type LocalConversationMethod = keyof LocalConversationMethods;
/** File content moves over the host's HTTP file endpoint, never through JSON-RPC or IPC. */
export interface LocalFileTransport {
  /** Stores an attachment and returns its id. */
  upload(scope: LocalConversationScope, file: File): Promise<string>;
  /** Reads an attachment id or a granted `fileRef`. */
  read(scope: LocalConversationScope, fileRef: string): Promise<Blob>;
  /** A URL the renderer can use directly, e.g. as an image source. */
  url(scope: LocalConversationScope, fileRef: string): string;
}
export interface LocalConversationClient {
  request<M extends LocalConversationMethod>(scope: LocalConversationScope, method: M, params: LocalConversationMethods[M]["params"]): Promise<LocalConversationMethods[M]["result"]>;
  subscribe(listener: (scope: LocalConversationScope, sessionId: string) => void): () => void;
  files: LocalFileTransport;
}

/** Adding an IPC method requires advertising it to the renderer. */
export const LOCAL_CONVERSATION_METHODS = {
  capabilities: true,
  queueEnqueue: true,
  queueUpdate: true,
  queueSide: true,
  stopBackgroundTasks: true,
  folderProjects: true,
  folderProjectAdd: true,
  sideCreate: true,
  sideAccepted: true,
  previewChoose: true,
  previewList: true,
  previewRead: true,
  importScan: true,
  importSessions: true,
  importCancel: true,
  providers: true,
  list: true,
  read: true,
  create: true,
  fork: true,
  update: true,
  directory: true,
  send: true,
  fileStore: true,
  fileInfo: true,
  fileRead: true,
  imageRead: true,
  cancel: true,
  answerQuestion: true,
  models: true,
  usage: true,
  remoteBegin: true,
  remoteSend: true,
  remoteUpdate: true,
} satisfies Record<LocalConversationMethod, true>;
