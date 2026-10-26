export interface SystemFontInfo {
  name: string;
  monospace: boolean;
}

export interface ListSystemFontsResult {
  fonts: SystemFontInfo[];
}

export interface ExportLogsResult {
  canceled: boolean;
  filePath: string | null;
  fileCount: number;
}

export interface SystemLogsSummaryResult {
  fileCount: number;
  totalBytes: number;
}

export interface ClearLogsResult {
  fileCount: number;
  totalBytes: number;
}

export type DoctorCliInstallStatus =
  | "installed"
  | "not-installed"
  | "broken"
  | "unavailable";

export interface DoctorCliInstallState {
  status: DoctorCliInstallStatus;
  linkPath: string;
  targetPath: string | null;
  message: string | null;
}

export interface InstallDoctorCliResult extends DoctorCliInstallState {
  installed: boolean;
}
