# Inspect provider tool results without losing their evidence

Local conversations use the same provider adapters for live execution and history imports. Tool text, structured results, status and file evidence stay associated with one native call; importing a conversation keeps the order in which its items first appeared. Reopening the local SQLite history preserves the same final states.

## Follow a result through the system

| Layer | Contract and responsibility |
| --- | --- |
| Claude host | Forward raw SDK messages. History augments only SDK-selected message UUIDs with `toolUseResult` and timestamps from the specified session's local JSONL. A raw history read is limited to 64 MiB; it does not import other branches or hidden messages. |
| Claude adapter | Convert `tool_use_result` into `result`, interpret `bashEditDiff` and Write patches, retain tool progress and background output references. Missing hunks and `moreFiles` set `file_changes_incomplete`; `changedFiles` paths remain visible. |
| Codex adapter | Interpret app-server items and command output deltas. Final output replaces streamed output; cancellation keeps received output. MCP `server` and short `tool` are independent fields. WebSearch, dynamic tools and native file changes retain their activities. |
| Common provider contract | `provider.Event` carries item identity, type, final state, payload and optional inline images. `provider.Transcript` collects adapter finals in first-appearance order for imports, replacing duplicate states by native item ID. |
| Recorder and storage | The common recorder serializes payloads; imported items receive conversation-local IDs and retain `source_item_id`. Schema extensions are optional JSON fields, without a new database migration. |
| File collector | `provider.FileChanges` exposes edits from standalone native file changes and command-attached changes. Both runners use the existing ordered file collector and exact baseline validation. Claude Write/Edit hook observations remain their own verified evidence. |
| GUI projection | Preserve original command input and structured `result` in the tool DTO. Render command-attached paths/diffs and incomplete notices inside the existing call. A details disclosure retains other structured result fields. |

The GUI integration uses the existing Vite adapter, with checked anchors against the pinned GUI source. It adds evidence to expanded tool content without modifying the vendored snapshot or creating an extra tool call. A Bash call that reports four changed files is still one Bash call.

## Distinguish reported patches from verified net changes

An event's `file_changes` is **provider-reported evidence for that call**. The resource ledger instead maintains a verified first baseline and latest contents. Shell/MCP writes and incomplete snapshots continue to reduce coverage. A reported patch becomes verified ledger evidence only when it applies exactly to the captured baseline and matches disk; paths without hunks remain uncertain.

History imports keep reported patches in the transcript but have no historical disk baseline. They do not populate a falsely verified cumulative ledger. Image bytes and private reasoning remain subject to the existing [import rules](local-conversation-import.md); images produced by a historical tool use an explicit native-context placeholder.

The current implementation retains structured tool results, background resource links and output file references. References do not grant new read permissions. Account limits and context-window usage continue through the existing [usage reader](local-provider-usage.md). Historical billing, cumulative cost UI and additional provider-specific plan/collaboration event families are separate capabilities; the tool-result fix does not introduce them.

## Verify the behavior

Use fake provider requests and temporary SQLite/files; no real agent CLI or model request is needed.

```sh
cd server
go test -race ./internal/localconversation/provider/... ./internal/localconversation/service ./internal/localconversation/filechanges ./internal/localconversation/protocol
```

From the repository root:

```sh
pnpm --filter @multica/desktop exec vitest run src/claude-host/history.test.ts src/claude-host/host.test.ts
pnpm --filter @multica/conversation-client exec vitest run models/turn-model.test.ts
pnpm --filter @multica/tutti-agent-gui-host exec vitest run src/tool-change-adapter.test.ts src/runtime/v2-tool-presentation.test.ts src/subagent-transcript.test.tsx
```

`service/import_evidence_test.go` writes both provider histories to SQLite and reopens the database. It verifies `before → call → after`, native provenance, failed output and file evidence. Provider tests cover complete/truncated patches, duplicate results, structured HTTP/MCP results, background artifacts, command interruption and WebSearch. The GUI boundary test verifies that file evidence survives projection on the original Bash call and MCP identity is prefixed once.
