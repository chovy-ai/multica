# Local conversation timing diagnostics

Local Codex and Claude Code turns write timing records automatically. Restart the
desktop main process after installing this change; refreshing its page cannot
enable main-process instrumentation.

## Location and privacy

The active Electron profile writes:

```text
<userData>/local-conversations/diagnostics/turn-timing.jsonl
<userData>/local-conversations/diagnostics/turn-timing.jsonl.1
```

On macOS, `userData` is under `~/Library/Application Support/<application name>`.
Canary profiles use their own application name. The file rotates at 5 MiB and
keeps one previous file. Writes are serialized, asynchronous, best effort and
limited to 1,000 pending records. They never delay a turn or fail a send. A full
disk or an overflowing diagnostic queue can therefore leave gaps in the log.
The directory is created with mode 0700 and files with mode 0600.

Only allowlisted stages, opaque conversation/request/turn IDs, provider, source,
timestamps, durations, outcomes and coarse error categories are accepted.
Message text, tool arguments/results, image data, filenames, credentials, raw
errors, environment variables and unrelated console output are excluded.
Renderer/GUI records pass the same validation before being written, including
in packaged builds. No diagnostics are uploaded.

## Export from Labs or MCP

On desktop, open **Settings → This device → Labs → Developer logs → Export logs**.
The native save dialog writes a JSON snapshot of the selected account/workspace's
retained local conversation records from the last 24 hours. Cancelling writes
nothing. Saving uses a private temporary file and an atomic rename; changing
accounts while the dialog is open cancels the operation. An empty snapshot is a
valid result when no records remain. Version information describes the running
desktop process, rather than whichever checkout happens to be on disk.

The automatically registered `multica_desktop_context` MCP also exposes
`export_developer_logs` to Codex and Claude Code, including without cloud login.
The tool is described in both providers' injected prompt. Its arguments are:

| Argument | Behavior |
| --- | --- |
| `request_id` | Required stable key for one export. Reuse it when retrying. |
| `scope` | `conversation` (default) or `workspace`. |
| `conversation_id` | Defaults to the current conversation. Explicit IDs must belong to this account/workspace. Omit for workspace exports. |
| `since_minutes` | 1–10,080, default 60. This filter cannot recover already rotated records. |

For example, call `export_developer_logs` with
`{"request_id":"latency-check","since_minutes":60}`. It returns the local JSON
path, record count, stage summary, time range and incomplete-read flag. Read the
path with a native file tool; the response does not inject every record into the
model context. No destination path or arbitrary file-read option is accepted.
Duplicate request IDs reuse the same result within an execution.

MCP exports live in `<userData>/local-conversations/diagnostics/exports/`, with
directory mode 0700 and file mode 0600. Each export prunes generated bundles
older than seven days and keeps at most 20. Files saved through the native dialog
are user-managed. Export bundles include allowlisted runtime versions, filters,
coverage, summary and validated timing records; raw console/native provider
logs, conversation text, tool arguments/results and credentials are excluded.

## Request flow

```text
GUI submit → renderer bridge → main admission → saved queue
  → queue dispatch/context → persist user turn → resolve attachments
  → prepare Multica credentials/MCP → provider lookup/configuration
  → spawn CLI or create/refresh Claude SDK query → deliver input
  → first provider event → first output/text → tool calls/user questions
  → provider result → process exit/foreground completion
  → save images, dispose context, recover images, persist final turn
  → renderer reads events → GUI applies the output/terminal projection
```

These phases overlap: the GUI may display output while the provider is still
running. Claude can retain its process for background tasks; foreground turn
completion does not mean that process exited.

## Reading a trace

Filter by `requestId` to join GUI submission, queue admission/dispatch and the
main-process execution. `turnId` joins execution with renderer/GUI delivery.
Use `conversationId` to distinguish concurrent conversations and Side sessions.

`at` is a UTC wall-clock timestamp for correlating processes. `elapsedMs` uses a
monotonic clock relative to that span's creation, **not** a shared cross-process
zero. Compare `at` across sources; use `durationMs` for a measured operation.
Start/end records delimit asynchronous operations and preserve failure outcomes.

| Stages | What the measurement establishes |
| --- | --- |
| `gui.submit`, `renderer.request`, `main.request` | Submission/admission latency at each bridge. This ends when accepted, not when the model finishes. |
| `queue.dispatch` | `durationMs` is time since the persisted prompt's creation, including intentional pause or waiting behind another turn. It is wall-clock based and can span an app restart. |
| `queue.context`, `attachments.resolve` | Time spent resolving referenced context and local files. |
| `context.prepare`, `context.credentials`, `context.mcp` | Total preparation, credential verification and local MCP server registration. MCP registration does not prove the provider has completed its own MCP handshake. |
| `provider.lookup`, `provider.config` | CLI discovery and native configuration loading. Codex configuration loading includes its separate app-server probe. |
| `provider.spawn` | Operating system confirmed creation of the execution process. |
| `provider.sdk_ready`, `provider.refresh` | Claude query creation or an existing query's MCP refresh completed. This is not evidence that a network request reached the model. |
| `provider.input_written`, `provider.input_yielded` | Input was written to CLI stdin or yielded to the Claude SDK. Neither means remote acceptance. |
| `provider.first_stdout`, `provider.first_stderr`, `provider.first_event` | First CLI bytes or protocol/SDK event. Startup events are distinct from a reply. |
| `provider.session_ready` | Provider reported a native session ID. |
| `provider.first_output`, `provider.first_text` | First parsed text/thinking/tool activity, and first nonempty assistant text, respectively. Codex exec may emit completed messages rather than individual tokens. |
| `provider.tool`, `user.question` | Tool invocation-to-result duration, or time waiting for a user's answer. Tool payloads and tool names are not logged. |
| `provider.retry`, `provider.failure` | Retry notices or failures with a coarse category: transport, authentication, rate limit, cancelled or other. Categories are hints, not a root-cause conclusion. |
| `provider.result`, `provider.exit`, `turn.result` | Native result/foreground settlement, CLI exit, and the service receiving the runner result. This separates model work from exit delay. |
| `images.save`, `context.dispose`, `images.recover`, `turn.save` | Post-processing and persistence. |
| `renderer.first_output_received` | First event read by this renderer instance; it may be a historical read after reopening. |
| `gui.first_output_applied`, `gui.terminal_applied` | Output/settlement applied to the GUI state for a turn observed live in this frame. This measures state application, not browser paint. History already completed when the frame opens is excluded. |

While dispatching or executing, a record with `event: "wait"` is emitted every
15 seconds. Its stage is the currently measured operation, or the last reached
checkpoint when no measured operation remains open. `idleMs` is time since the
last observed activity; it does not prove the provider has stopped working.
`turn.finished` ends the span and stops its heartbeat on success, failure or
cancellation. Admission spans without a turn ID are distinct from execution.

If input delivery is fast but first output is late, investigate the provider's
native logs/network/service next. If first output is timely but GUI application
is late, inspect event notification, history reads and GUI reconciliation. A
late `provider.exit` after `provider.result` instead indicates process teardown.

## Verification

Tests inject fake executables/SDK transports and never call a real model:

```sh
pnpm --filter @multica/desktop exec vitest run src/main/local-timing-log.test.ts src/main/local-provider-runner.test.ts src/main/local-conversation-service.test.ts src/main/local-conversation-queue.test.ts src/main/local-claude-conversation.test.ts src/main/local-multica-context.test.ts src/renderer/src/platform/local-conversation-service.test.ts
pnpm --filter @multica/desktop exec vitest run src/main/developer-log-export.test.ts src/main/local-context-mcp.test.ts src/renderer/src/components/labs-settings-tab.test.tsx
pnpm --filter @multica/views exec vitest run settings/components/settings-page.test.tsx settings/components/settings-navigation.test.ts locales/parity.test.ts
pnpm --filter @multica/tutti-agent-gui-host exec vitest run src/local-timing.test.ts src/runtime/runtime.test.ts
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/tutti-agent-gui-host typecheck
```

The export tests cover scoped records, validation after log rotation, native
save cancellation/failure, account changes during the save dialog, restrictive
file permissions, generated-file retention, MCP retry deduplication and actual
MCP registration/calls without cloud credentials. UI tests cover pending,
success, cancellation and retry. Manual desktop verification should save and
inspect a real JSON file, cancel a second export and check both themes. Restore
the original theme afterwards.
