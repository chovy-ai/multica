import type { WorkspaceAgentActivityTimelineItem } from "../../../shared/workspaceAgentTimelineTypes";
import type { AgentGUITimelineRow } from "./agentGuiConversationTypes";

export function timelineRowTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): number {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

export function timelineRowStatus(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  rowID: string
): string | null {
  const item = timelineItems.find((candidate) => itemID(candidate) === rowID);
  return itemStatus(item);
}

export function timelineRowTimeByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): number {
  const item = [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
  return item?.occurredAtUnixMs ?? item?.createdAtUnixMs ?? 0;
}

export function timelineRowStatusByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): string | null {
  const item = latestTimelineItemByCallId(timelineItems, callID);
  return itemStatus(item);
}

export function latestTimelineItemByCallId(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  callID: string
): WorkspaceAgentActivityTimelineItem | undefined {
  return [...timelineItems]
    .filter((candidate) => candidate.callId?.trim() === callID)
    .sort(
      (left, right) =>
        (right.occurredAtUnixMs ?? 0) - (left.occurredAtUnixMs ?? 0)
    )[0];
}

export function itemStatus(
  item: WorkspaceAgentActivityTimelineItem | undefined
): string | null {
  if (!item) {
    return null;
  }
  return item.status?.trim() || stringPayload(item.payload?.status) || null;
}

export function itemID(item: WorkspaceAgentActivityTimelineItem): string {
  const eventID = item.eventId?.trim();
  if (eventID) {
    return eventID;
  }
  if (Number.isFinite(item.id) && item.id > 0) {
    return `server:${item.id}`;
  }
  return `local:${item.occurredAtUnixMs ?? 0}:${item.itemType}:${item.role ?? ""}`;
}

export function stableTimelineRowID(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[],
  detailItemID: string
): string {
  const item = timelineItems.find(
    (candidate) => itemID(candidate) === detailItemID
  );
  const eventID = item?.eventId?.trim();
  return eventID ? `event:${eventID}` : detailItemID;
}

export function normalizeToolCallID(callID: string): string {
  return callID.startsWith("call:") ? callID.slice("call:".length) : callID;
}

export function dedupeTimelineRowsByID(
  rows: AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  const byID = new Map<string, AgentGUITimelineRow>();
  for (const row of rows) {
    byID.set(row.id, row);
  }
  return sortTimelineRows([...byID.values()]);
}

export function sortTimelineRows(
  rows: AgentGUITimelineRow[]
): AgentGUITimelineRow[] {
  return rows.sort(
    (a, b) =>
      a.occurredAtUnixMs - b.occurredAtUnixMs || a.id.localeCompare(b.id)
  );
}

export function latestTimelineTime(
  timelineItems: readonly WorkspaceAgentActivityTimelineItem[]
): number {
  return Math.max(
    0,
    ...timelineItems.map(
      (item) => item.occurredAtUnixMs ?? item.createdAtUnixMs ?? 0
    )
  );
}

export function stringPayload(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function objectPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function hashStringToPositiveInt(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}
