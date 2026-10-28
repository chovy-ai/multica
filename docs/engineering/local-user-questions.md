# Questions in local conversations

Local Codex and Claude Code turns automatically register `ask_user_question` on
the per-run `multica_desktop_context` MCP server. The execution prompt directs
the provider to use it for clarification instead of a native question tool that
may be unavailable in its noninteractive CLI mode. This also applies to Side
conversations. Cloud agents invoked through `@` retain their server execution
contract; this change does not add a remote question-response endpoint.

The tool accepts a stable `request_id` and one to four questions. Each question
has a unique `id`, a `question`, optional `header` and options, and `multiSelect`
and `allowFreeText` flags. It supports single selection, multiple selection,
and a written answer. Questions permitting free text always show a text area
below their options, including when the conversation-return action is present.
On single-choice questions a written answer takes precedence over a selected
option; on multiple-choice questions it is appended to the selected options.
The result is `answersByQuestionId`, with strings for
single answers and arrays for multiple selections. Repeating one request ID
with the same input reuses its pending/result record; changed input is rejected.

The MCP callback is bound to the current account, workspace, conversation and
turn by the main process. It persists a pending question, notifies the renderer,
and waits. The GUI adapter projects that record as a canonical question
interaction and reuses Tutti's question surface with Multica's theme tokens.
`interaction.respond` routes through the local parent transport to the main
process's `answerQuestion` request. All questions and choices are validated;
the answer is saved before the MCP call resolves and the same provider process
continues. A replay of the same answer is idempotent; a conflicting answer is
rejected. This channel never approves command or tool permissions.

Pending questions survive renderer reloads and navigation because the main
process owns the wait. Canceling the run, changing accounts, closing the app,
or canceling the MCP call ends that wait. Application restart marks interrupted
questions canceled; their historical cards cannot answer a new execution.
Previously answered questions and answers remain in local history.

Codex's per-server `tool_timeout_sec` and Claude's per-server `timeout` are set
to one hour for this run's question-enabled server. Claude MCP automatic
backgrounding is disabled only in the child environment so the question keeps
the turn attached. These are execution-local overlays; user configuration is
not rewritten. The settings follow the official
[Codex MCP configuration](https://developers.openai.com/codex/mcp) and
[Claude MCP call limits](https://code.claude.com/docs/en/mcp#time-limits-on-mcp-tool-calls).
After a provider timeout the pending card is canceled when that execution ends.

Validation:

```sh
pnpm --filter @multica/desktop test src/local-host/local-user-question.test.ts src/local-host/local-context-mcp.test.ts src/local-host/local-conversation-service.test.ts src/local-host/local-provider-runner.test.ts
pnpm --filter @multica/tutti-agent-gui-host test src/runtime/runtime.test.ts
pnpm --filter @multica/desktop typecheck
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/desktop build
PLAYWRIGHT_BASE_URL=http://localhost:16099 pnpm exec playwright test e2e/local-user-question.spec.ts e2e/local-conversation-queue.spec.ts
```

The tests use test-owned provider clients and fake executions. Default tests
never discover or execute a logged-in model CLI.
