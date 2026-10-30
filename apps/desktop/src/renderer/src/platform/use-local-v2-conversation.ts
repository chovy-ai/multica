import { useCallback, useEffect, useSyncExternalStore } from "react";
import { localV2ServerMessageSchema, type LocalV2Scope } from "@multica/core/local-conversation/v2";
import { V2Conversation } from "@multica/tutti-agent-gui-host/v2-conversation";
import { localV2 } from "./local-v2";
import { useLocalDevice, type LocalDevice } from "./local-device";

export interface LiveConversation {
  conversation?: V2Conversation;
  /** Changes whenever the conversation does; V2Conversation updates in place. */
  version: number;
  error: Error | null;
  pending: boolean;
  retry(): void;
}

interface Entry {
  state: { conversation?: V2Conversation; version: number; error: Error | null };
  listeners: Set<() => void>;
  users: number;
  loading: boolean;
  stop?: () => void;
  release?: ReturnType<typeof setTimeout>;
  load(): void;
}

/** How long an unused conversation stays in memory, so switching back shows it at once. */
const KEEP_MS = 60_000;

const entries = new Map<string, Entry>();
const idle: Entry["state"] = { version: 0, error: null };

/**
 * One live copy per conversation: its snapshot, then its events. A gap or a
 * lost subscription reads the snapshot again; the last user unsubscribes.
 */
function entryKey(device: LocalDevice, scope: LocalV2Scope, id: string | null | undefined) {
  return JSON.stringify([device.id, scope.userId, scope.workspaceId, id]);
}

function entry(device: LocalDevice, scope: LocalV2Scope, id: string): Entry {
  const key = entryKey(device, scope, id);
  let current = entries.get(key);
  if (current) return current;
  const client = localV2(device.transport, scope);
  const value: Entry = {
    state: idle, listeners: new Set(), users: 0, loading: false,
    load() {
      if (value.loading || !value.users) return;
      value.loading = true; value.stop?.(); value.stop = undefined;
      const set = (state: Entry["state"]) => { value.state = state; value.listeners.forEach((listener) => listener()); };
      client.snapshot(id).then((snapshot) => {
        if (!value.users) return;
        const conversation = V2Conversation.fromSnapshot(snapshot);
        set({ conversation, version: value.state.version + 1, error: null });
        value.stop = client.subscribe(id, conversation.seq, conversation.storeGeneration, (raw) => {
          const parsed = localV2ServerMessageSchema.safeParse(raw);
          if (!parsed.success || value.state.conversation !== conversation) return;
          const message = parsed.data;
          if (message.type === "conversation.events") {
            if (conversation.apply(message.events) === "gap") value.load();
            else set({ ...value.state, version: value.state.version + 1 });
          } else if (message.type === "subscription.status" && message.status !== "subscribed" && message.status !== "live") value.load();
        });
      }, (error: unknown) => {
        if (value.users) set({ ...value.state, error: error instanceof Error ? error : new Error(String(error)) });
      }).finally(() => { value.loading = false; });
    },
  };
  entries.set(key, value);
  current = value;
  return current;
}

function release(key: string, value: Entry) {
  value.stop?.(); value.stop = undefined;
  value.release = setTimeout(() => { if (!value.users && entries.get(key) === value) entries.delete(key); }, KEEP_MS);
}

/** A conversation kept current while enabled, shared by every view of it. */
export function useLocalV2Conversation(scope: LocalV2Scope, id: string | null | undefined, enabled = true): LiveConversation {
  const device = useLocalDevice();
  const target = id ? entry(device, scope, id) : undefined;
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => { if (!target) return () => {}; target.listeners.add(listener); return () => { target.listeners.delete(listener); }; }, [target]),
    () => target?.state ?? idle,
  );
  useEffect(() => {
    if (!enabled || !target) return;
    // The first user reads a fresh snapshot; until it arrives the last one stays shown.
    clearTimeout(target.release);
    if (!target.users++) target.load();
    return () => { if (!--target.users) release(entryKey(device, scope, id), target); };
  }, [enabled, target, device, scope, id]);
  return { conversation: state.conversation, version: state.version, error: state.error, pending: !!id && !state.conversation && !state.error,
    retry: () => { if (target) { target.state = { ...target.state, error: null }; target.load(); } } };
}
