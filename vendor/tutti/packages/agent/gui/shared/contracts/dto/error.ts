export const APP_ERROR_CODES = [
  "common.invalid_input",
  "common.approved_path_required",
  "common.unavailable",
  "common.unexpected",
  "session.not_found",
  "control_surface.unauthorized",
  "workspace.select_directory_failed",
  "workspace.select_files_failed",
  "workspace.ensure_directory_failed",
  "workspace.import_files_failed",
  "workspace.read_file_failed",
  "workspace.write_file_failed",
  "workspace.export_file_failed",
  "workspace.copy_path_failed",
  "workspace.host_unsupported",
  "workspace.runtime_artifact_unavailable",
  "runtime.guest_agent_lane_unavailable",
  "workspace.room_full",
  "workspace.room_delete_forbidden",
  "workspace.room_delete_not_found",
  "filesystem.create_directory_failed",
  "filesystem.read_file_bytes_failed",
  "filesystem.read_file_text_failed",
  "filesystem.write_file_text_failed",
  "filesystem.copy_entry_failed",
  "filesystem.move_entry_failed",
  "filesystem.rename_entry_failed",
  "filesystem.delete_entry_failed",
  "filesystem.read_directory_failed",
  "filesystem.stat_failed",
  "terminal.spawn_failed",
  "terminal.write_failed",
  "terminal.resize_failed",
  "terminal.close_failed",
  "terminal.attach_failed",
  "terminal.detach_failed",
  "terminal.snapshot_failed",
  "agent.list_models_failed",
  "agent.launch_failed",
  "agent.read_last_message_failed",
  "agent.provider_session_not_found",
  "agent.resume_session_not_local",
  "agent.resume_session_resolve_failed",
  "agent.settings_require_new_session",
  "task.suggest_title_failed",
  "persistence.unavailable",
  "persistence.quota_exceeded",
  "persistence.payload_too_large",
  "persistence.io_failed",
  "persistence.invalid_state",
  "persistence.invalid_node_id",
  "update.get_state_failed",
  "update.configure_failed",
  "update.check_failed",
  "update.download_failed",
  "update.install_failed",
  "PACKAGE_DOWNLOAD_INTERRUPTED",
  "PACKAGE_DOWNLOAD_HTTP_STATUS",
  "PACKAGE_DOWNLOAD_INVALID",
  "PACKAGE_DOWNLOAD_DISK_ERROR"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export type AppErrorParamValue = boolean | number | string | null;

export type AppErrorParams = Record<string, AppErrorParamValue>;

export interface AppErrorDescriptor {
  code: AppErrorCode;
  params?: AppErrorParams;
  debugMessage?: string;
}
