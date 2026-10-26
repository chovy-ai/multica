import type {
  AppErrorCode,
  AppErrorDescriptor,
  AppErrorParams
} from "../contracts/dto";
import type { IpcInvokeResult } from "../contracts/ipc";

function createMessageMap(): Record<AppErrorCode, string> {
  return {
    "common.invalid_input": "The request was invalid.",
    "common.approved_path_required":
      "The selected path is outside approved workspaces.",
    "common.unavailable": "This feature is unavailable.",
    "common.unexpected": "Something went wrong. Please try again.",
    "session.not_found": "Session not found.",
    "control_surface.unauthorized": "Unauthorized request.",
    "workspace.select_directory_failed": "Unable to open the directory picker.",
    "workspace.select_files_failed": "Unable to open the file picker.",
    "workspace.ensure_directory_failed": "Unable to create the directory.",
    "workspace.import_files_failed": "Unable to import the selected files.",
    "workspace.read_file_failed": "Unable to load the selected file.",
    "workspace.write_file_failed": "Unable to save the selected file.",
    "workspace.export_file_failed": "Unable to export the selected file.",
    "workspace.copy_path_failed": "Unable to copy the path.",
    "workspace.host_unsupported":
      "This Mac cannot run the workspace environment required by tsh. Please use macOS 13 or later on Apple Silicon (or an Intel Mac that supports Apple Virtualization), and ensure virtualization is not blocked by MDM.",
    "workspace.runtime_artifact_unavailable":
      "Unable to prepare the workspace environment required by tsh. Check your network connection and try again.",
    "runtime.guest_agent_lane_unavailable":
      "The workspace environment connection is unavailable. Refresh and try again.",
    "workspace.room_full": "Room is full.",
    "workspace.room_delete_forbidden":
      "Only the space owner can delete this space.",
    "workspace.room_delete_not_found": "This space no longer exists.",
    "filesystem.create_directory_failed": "Unable to create the directory.",
    "filesystem.read_file_bytes_failed": "Unable to read the file.",
    "filesystem.read_file_text_failed": "Unable to read the file.",
    "filesystem.write_file_text_failed": "Unable to save the file.",
    "filesystem.copy_entry_failed": "Unable to copy the file or folder.",
    "filesystem.move_entry_failed": "Unable to move the file or folder.",
    "filesystem.rename_entry_failed": "Unable to rename the file or folder.",
    "filesystem.delete_entry_failed": "Unable to delete the file or folder.",
    "filesystem.read_directory_failed": "Unable to load the directory.",
    "filesystem.stat_failed": "Unable to read file details.",
    "terminal.spawn_failed": "Unable to start the terminal.",
    "terminal.write_failed": "Unable to write to the terminal.",
    "terminal.resize_failed": "Unable to resize the terminal.",
    "terminal.close_failed": "Unable to close the terminal.",
    "terminal.attach_failed": "Unable to attach the terminal session.",
    "terminal.detach_failed": "Unable to detach the terminal session.",
    "terminal.snapshot_failed": "Unable to read terminal output.",
    "agent.list_models_failed": "Unable to load models for this provider.",
    "agent.launch_failed": "Unable to start the agent.",
    "agent.read_last_message_failed": "Unable to read the last agent message.",
    "agent.provider_session_not_found":
      "The previous agent session can no longer be restored.",
    "agent.resume_session_not_local":
      "The previous agent session is not available on this machine.",
    "agent.resume_session_resolve_failed":
      "Unable to resolve the previous agent session.",
    "agent.settings_require_new_session":
      "This model can only be used in a new session to preserve context.",
    "task.suggest_title_failed": "Unable to generate task details.",
    "persistence.unavailable":
      "Storage is unavailable; changes will not be saved.",
    "persistence.quota_exceeded": "Storage quota was exceeded.",
    "persistence.payload_too_large": "Workspace state is too large to save.",
    "persistence.io_failed": "Unable to save data to storage.",
    "persistence.invalid_state": "The workspace state could not be saved.",
    "persistence.invalid_node_id": "The terminal history could not be saved.",
    "update.get_state_failed": "Unable to read the update status.",
    "update.configure_failed": "Unable to apply update settings.",
    "update.check_failed": "Unable to check for updates.",
    "update.download_failed": "Unable to download the update.",
    "update.install_failed": "Unable to install the update.",
    PACKAGE_DOWNLOAD_INTERRUPTED:
      "The agent package download was interrupted. Check your network connection and retry.",
    PACKAGE_DOWNLOAD_HTTP_STATUS:
      "The agent package server rejected the download. Retry later or contact support.",
    PACKAGE_DOWNLOAD_INVALID:
      "The downloaded agent package failed integrity checks. Retry the download.",
    PACKAGE_DOWNLOAD_DISK_ERROR:
      "Unable to write the agent package cache. Check disk permissions and free space."
  };
}

const APP_ERROR_MESSAGES = createMessageMap();

function normalizeDebugMessage(error: unknown): string | undefined {
  if (error instanceof TshAppError) {
    return error.debugMessage;
  }

  if (error instanceof Error) {
    return error.message.length > 0
      ? `${error.name}: ${error.message}`
      : error.name;
  }

  if (typeof error === "string") {
    return error.length > 0 ? error : undefined;
  }

  return undefined;
}

export function createAppErrorDescriptor(
  code: AppErrorCode,
  options: {
    params?: AppErrorParams;
    debugMessage?: string;
  } = {}
): AppErrorDescriptor {
  return {
    code,
    ...(options.params ? { params: options.params } : {}),
    ...(options.debugMessage ? { debugMessage: options.debugMessage } : {})
  };
}

export function isAppErrorDescriptor(
  value: unknown
): value is AppErrorDescriptor {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && record.code in APP_ERROR_MESSAGES;
}

export function getAppErrorCode(error: unknown): AppErrorCode | null {
  if (error instanceof TshAppError) {
    return error.code;
  }

  if (isAppErrorDescriptor(error)) {
    return error.code;
  }

  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code in APP_ERROR_MESSAGES) {
      return code as AppErrorCode;
    }
  }

  return null;
}

export class TshAppError extends Error {
  public readonly code: AppErrorCode;
  public readonly params: AppErrorParams | undefined;
  public readonly debugMessage: string | undefined;

  public constructor(descriptor: AppErrorDescriptor) {
    super(formatAppErrorMessage(descriptor));
    this.name = "TshAppError";
    this.code = descriptor.code;
    this.params = descriptor.params;
    this.debugMessage = descriptor.debugMessage;
  }

  public toDescriptor(): AppErrorDescriptor {
    return createAppErrorDescriptor(this.code, {
      params: this.params,
      debugMessage: this.debugMessage
    });
  }
}

export function createAppError(
  codeOrDescriptor: AppErrorCode | AppErrorDescriptor,
  options: {
    params?: AppErrorParams;
    debugMessage?: string;
  } = {}
): TshAppError {
  const descriptor =
    typeof codeOrDescriptor === "string"
      ? createAppErrorDescriptor(codeOrDescriptor, options)
      : codeOrDescriptor;

  return new TshAppError(descriptor);
}

export function toAppErrorDescriptor(
  error: unknown,
  fallbackCode: AppErrorCode = "common.unexpected"
): AppErrorDescriptor {
  if (error instanceof TshAppError) {
    return error.toDescriptor();
  }

  if (isAppErrorDescriptor(error)) {
    return error;
  }

  return createAppErrorDescriptor(fallbackCode, {
    debugMessage: normalizeDebugMessage(error)
  });
}

export function formatAppErrorMessage(
  error: AppErrorDescriptor | TshAppError
): string {
  const descriptor =
    error instanceof TshAppError ? error.toDescriptor() : error;
  return (
    APP_ERROR_MESSAGES[descriptor.code] ??
    APP_ERROR_MESSAGES["common.unexpected"]
  );
}

export function getAppErrorDebugMessage(
  error: AppErrorDescriptor | TshAppError | Error | string | null | undefined
): string | undefined {
  if (!error) {
    return undefined;
  }

  if (error instanceof TshAppError) {
    return error.debugMessage;
  }

  if (isAppErrorDescriptor(error)) {
    return error.debugMessage;
  }

  return normalizeDebugMessage(error);
}

export function isIpcInvokeResult<T>(
  value: unknown
): value is IpcInvokeResult<T> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.__tshIpcEnvelope === true && typeof record.ok === "boolean";
}
