# Local conversation forks through a turn

The conversation footer uses Tutti's existing turn-fork action immediately after Copy. The host advertises this lifecycle capability only for local conversation targets; ordinary official Chat keeps its existing capabilities. Completed, failed and cancelled turns may be forked. An earlier settled turn can be forked while a later turn is running; a currently running boundary must settle first.

`session.fork` is private GUI RPC, forwarded to desktop IPC `fork` with the local conversation ID, turn ID and request ID. Account and workspace scope remain enforced by `LocalConversationService`. A persisted request ID makes retries return the existing branch. The official Server API is unchanged.

Codex reads native history through `app-server thread/read` and forks with `thread/fork lastTurnId`. Claude uses the bundled official SDK's `getSessionMessages` and `forkSession upToMessageId`. Ordered authored prompts must match the native history before a boundary is used. Codex's returned prefix is checked again, so a CLI ignoring the boundary cannot silently deliver later turns. No inference or source-transcript mutation is required to fork.

Historical messages with no reliable native boundary, and turns executed by official mentioned agents, use a saved-context fork. The new branch has no inherited native session ID. Its first local send supplies the branch's saved messages as quoted context, then later sends resume its own new native session. The initial excerpt includes the latest 20 messages, up to 32,000 characters each, and explicit omission flags. The built-in context MCP can read the full branch history and saved tool results. Hidden or unsaved provider state is not reconstructed. The UI labels these branches “上下文分叉” / “Context fork”. Transport and native fork failures do not silently become saved-context forks.

The local branch stores only messages through the selected boundary, fresh local message/turn IDs, the original working directory, project and model, and persistent `forkedFrom` / `forkedFromTurnId` lineage. `forkedTurnId` records the selected boundary's new local ID, even when parallel agents finish out of order. Saved tool events after the boundary's completion time are excluded; unfinished sibling executions become cancelled snapshots. Historical official-agent attribution remains, but live cloud session/task bindings are removed. The list retains the branch with a `· Fork` title, and its header opens the source conversation, including archived sources. The source remains unchanged.

Validation:

```sh
pnpm --filter @multica/desktop test src/local-host/local-conversation-service.test.ts src/local-host/local-provider-fork.test.ts src/renderer/src/platform/local-conversation-service.test.ts src/renderer/src/pages/local-conversation-flow.test.tsx
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/tutti-agent-gui-host build
pnpm --filter @multica/desktop build
PLAYWRIGHT_BASE_URL=http://localhost:16099 pnpm exec playwright test e2e/local-turn-fork.spec.ts
```

Default tests use explicit fake model executables and synthetic transcripts, including real Claude SDK transcript mutation, without discovering installed model CLIs or using model quota. A separate gated manual Codex protocol check uses a temporary `CODEX_HOME`, synthetic native history, and read/fork/read RPC only; it verified that a two-turn source produces a one-turn branch and the source file remains unchanged. Browser tests verify the footer position, exact boundary request, selected-prefix rendering and source restoration for both providers.
