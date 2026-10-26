# Conversation flow: two panes and execution selection

## Scope and references

The supplied Multica Chat screenshot defines the two-pane composition: session
history on the left, the selected conversation on the right. The Conversations
tab retains Tutti's transcript, composer, attachments, and Sessions / Tasks /
Agents references. The original Chat route keeps its own presentation and
selection. Claude Code execution remains outside this acceptance run.

Reference implementations:

- `packages/views/chat/chat-page.tsx` and its thread list / session header.
- `packages/views/tutti-agent-gui/conversation-flow-page.tsx` and parent service.
- `packages/tutti-agent-gui-host/src/application.tsx` and runtime projection.
- Tutti's public `AgentGUI.renderSlots.composerFooterAccessory` and controlled
  node state, under the pinned `vendor/tutti` revision.
- Multica's runtime model discovery and direct-chat task queue / claim path.

## Concept mapping

| Existing concept | Conversations implementation |
| --- | --- |
| Provider rail / project and session rail | Multica `ChatThreadList`, scoped to the Conversations URL |
| Session row / row action | Existing avatar, preview, unread, pin, archive and delete components |
| Session heading | Existing `ChatSessionHeader` with an explicit deletion callback |
| Source transcript / composer | Public Tutti GUI in its isolated document, retained intact |
| Agent target | Real workspace Agent and its bound Multica runtime |
| Composer footer accessory | Host Agent / model selection controls |
| Model preference | Per-session / draft preference and per-turn execution override |
| Chat's active-session pointer | Unchanged; never used as the Conversations selection authority |

## Protocol and state boundaries

Session identities, Agent identities, attachment identities, task references,
workspace authentication and task status enums keep their existing meanings.
The iframe has no authentication token. Authenticated API requests stay in the
parent, and its private MessageChannel validates current workspace and session
ownership before mutations. Existing context-reference snapshots keep the
current content contract.

Model selection is an additive direct-chat request option, `model?: string`, on
the existing message-send endpoint. Omitting it retains the Agent's configured
default. It applies to the queued turn and survives retry without updating the
Agent row. Agent changes select a fresh conversation scope; the previous
session, history and draft stay in their original scope. A model preference
from one Agent must not carry into another Agent's scope.

## UI implementation

The parent reuses Multica's public UI components and semantic tokens. The
embedded footer composes Tutti's public UI System primitives. No new design
system dependency is required: this is a presentation change to the already
integrated GUI, not a replacement of the requested source composer. Vendor
files remain unchanged. Host-scoped CSS hides the redundant embedded rails.

The layout keeps the iframe mounted when the list is hidden at compact widths,
so opening the list or changing viewport width does not discard a draft. The
Agent and model controls show their real availability, discovery state and
errors, and are disabled during a turn submission or execution.

## Acceptance

See the repository-root `design-qa.md` for current visual evidence and status.
Automated coverage includes independent routing, successful-only selection
advance, compact draft preservation, model discovery / persistence / send,
task claim / retry model override and unchanged native Chat behavior.

### Execution evidence

Two messages were sent from the real desktop GUI to the locally authenticated
Codex runtime. Both completed without tool calls and retained provider session
`01a16b81-dc52-7f72-be5f-fc047a539130`:

| Turn | Request override | Reported usage model | Result |
| --- | --- | --- | --- |
| `01a16b81-db88-7f03-9cd8-b9c767ffb09f` | `gpt-6-luna` | `gpt-6-luna` | `CODEX_MODEL_SELECTED`, completed |
| `01a16b82-9120-7c87-a6dd-aa2915e9418b` | omitted | `gpt-6.1-sol` | `CODEX_MODEL_DEFAULT`, completed |

The Agent's stored model remained null. Codex's resume API would otherwise
retain the previous turn's model when given no override. The daemon now marks
empty effective Chat models with `RestoreConfiguredModel`; on resume, the same
Codex process resolves its effective `config/read(cwd)` model, or its paginated
`model/list` default when no model is configured. It passes that explicit model
to `thread/resume`. An ambiguous or unavailable default fails explicitly rather
than silently retaining the previous override. Other task types keep their
existing behavior, and the model catalog is never hard-coded.

Safe run metadata is saved in
`.tmp/multica-gui-restoration/two-pane-real-codex-models.json`.

### Verification commands and results

- `pnpm --filter @multica/tutti-agent-gui-host test`: 30 passed.
- `pnpm --filter @multica/core exec vitest run api/client.test.ts`: 126 passed.
- Views targeted tests for Conversations, list/header reuse, floating-overlay
  route gating and the existing Chat components: 187 passed in 9 files.
- Host, Views, Core and Desktop type checks: passed. Scoped lint: passed.
- Handler model validation / transactional send / claim / retry / runtime
  rebind tests: passed using test fixtures. Service model parsing and provider
  policies: passed. `go vet` passed for the changed backend packages.
- `(cd server && go test ./pkg/agent -run '^TestCodex' -parallel 2 -count=1)`:
  all Codex fake-process tests passed in 35.002 seconds. Default parallelism
  first exhausted the fake-process initialization budget; no timeout or
  assertion was relaxed. Tests never resolve the user's Codex executable.
- `make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts --trace retain-on-failure'`:
  1 passed in 43.1 seconds, covering themes, compact widths, keyboard menus,
  model persistence / isolation, references, attachments and cancel/resend.
- `pnpm --filter @multica/desktop build`: passed. API and daemon were rebuilt
  in the managed environment; the desktop was restarted for final inspection.
- `node vendor/tutti/sync.mjs --verify`: 2,491 upstream files unchanged and 22
  package metadata overlays verified. `git diff --check`: passed.

### Interaction fixes found during acceptance

The imported window's capture guard blocks menu portals without `.nodrag`.
Both new public dropdown contents now declare that existing host-interaction
boundary. The shared Chat floating overlay and its shortcut are suppressed on
Conversations to keep the footer controls unobstructed. The parent marks the
visible, foreground session's latest message as read using the existing
mutation; a bounded per-message attempt avoids repeated retries on failure.
Late new-session responses cannot override a newer manual selection, and
member-query failures use the list's existing retry state.

### Limits

Drafts and attachments stay with their original session or Agent draft scope;
switching Agents does not transfer that context. Upstream rich-text draft state
follows the mounted GUI lifetime; this change does not add cross-tab draft
persistence. Model catalogs, account access
and execution still depend on the selected runtime. This acceptance exercised
real Codex only; Claude Code was not invoked. Existing source runtime
capability limits and packaging constraints remain documented in the host
README. No release, installer signing or publication was requested.
