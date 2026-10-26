export interface TerminalWindowsPty {
  backend: "conpty";
  buildNumber: number;
}

export type TerminalRuntimeKind = "windows" | "wsl" | "posix";

export interface TerminalProfile {
  id: string;
  label: string;
  runtimeKind: TerminalRuntimeKind;
}

export interface ListTerminalProfilesResult {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
}

export type TerminalWriteEncoding = "utf8" | "binary";

export type TerminalWriteProvenance = "user" | "auto";

export interface TerminalTransportWriteInput {
  sessionId: string;
  data: string;
  encoding?: TerminalWriteEncoding;
  provenance?: TerminalWriteProvenance;
}

export interface TerminalTransportResizeInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalTransportAttachInput {
  sessionId: string;
  clientId?: string;
  afterSeq?: number;
}

export interface TerminalTransportDetachInput {
  sessionId: string;
}

export interface TerminalTransportSnapshotInput {
  sessionId: string;
}

export interface TerminalTransportSnapshotResult {
  data: string;
  fromSeq?: number;
  toSeq?: number;
  truncated?: boolean;
  updatedAt?: number;
}

export interface TerminalTransportDataEvent {
  sessionId: string;
  data: string;
  seq?: number;
}

export interface TerminalTransportExitEvent {
  sessionId: string;
  exitCode: number;
}

export type TerminalSessionState = "working" | "standby" | "failed";

export type TerminalTransportSessionState = TerminalSessionState;

export interface TerminalTransportSessionStateEvent {
  sessionId: string;
  state: TerminalTransportSessionState;
  errorMessage?: string;
}

export interface TerminalTransportSessionMetadataEvent {
  sessionId: string;
  resumeSessionId: string | null;
  profileId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
}
