# Conversation UI interaction polish

## Scope

Improve the existing desktop Conversations flow without replacing its
framework, navigation, source transcript, execution protocol or native Chat.
Current-run native screenshots are under `.tmp/conversation-ui-polish/`.

## Audit and implementation target

| Step | Current evidence | Finding | Scoped change |
| --- | --- | --- | --- |
| 1. Find a conversation | `01-before-desktop.png` | No search affordance; similar long titles are hard to distinguish | Search title, Agent and last-message preview, with clear and no-results recovery |
| 2. Choose an Agent | `02-before-agent-menu.png` | Narrow menu wraps a short Agent name and splits the switch consequence into many lines | Give the public dropdown a bounded readable width and keep names readable |
| 3. Choose a model | `03-before-model-menu.png` | Default model wraps despite ample viewport space; the trigger's accessible name omits its current value | Adaptive menu width, current-value description, explicit default-model trigger label |
| 4. Read in a narrow window | `04-before-window.png` | Two stacked header rows consume reading space | Add an optional leading control to the existing session header and reuse one header row |
| 5. Return from the narrow list | `05-before-compact-list.png` | No way back to the current conversation except selecting a row | Add a clear return action that retains the mounted composer and draft |

The input footer also exposes a permanently disabled Handoff control in this
integration. Hide only the disabled source trigger at the host presentation
boundary; keep attachment and reference actions. The two-column list will use
a more compact bounded width so the transcript gains reading space.

The current components already provide selected states, real menu radio
values, keyboard focus and semantic theme tokens. Reuse these components.
No new routes, dependencies, backend changes or source-vendor edits are needed.

## Accessibility and verification boundary

Screenshots establish menu wrapping, hierarchy and visible controls. They do
not establish full accessibility compliance. Check keyboard return/clear,
current-value descriptions, real menu activation, responsive overflow and
retained iframe/draft state with component and end-to-end checks. Verify the
changed desktop window after rebuilding. No model inference is required for
this UI-only pass.

## Result

Passed for the scoped UI work. The framework, routes and execution protocol
are retained. Original Chat keeps its default layout and behavior.

| Step | Result and final evidence | Health |
| --- | --- | --- |
| 1. Find a conversation | Search title, Agent and last-message text; clear button, Escape and no-results recovery; `13-after-desktop-light.png`, `07-after-search-empty.png` | Good |
| 2. Choose an Agent | Readable 300px menu, left-aligned names, status and switch consequence; `11-after-agent-menu.png` | Good |
| 3. Choose a model | Default name fits, current value is exposed as an accessible description, scope is explicit; `12-after-model-menu.png` | Good |
| 4. Read in a narrow window | One 48px header instead of two, retained attachment/reference controls; `15-after-compact-restart.png` | Good |
| 5. Return from the narrow list | Return action retains current selection, mounted iframe and draft, even with no search results; `07-after-search-empty.png` and E2E assertions | Good |

The desktop list now uses a bounded 28% / 260–360px width. The source's
disabled Handoff action is hidden only in this host presentation. No source
vendor files were modified.

### Status consistency fix

Native inspection found the header showing Codex online while the new menu
showed offline. `workspaceLoad()` had treated an absent optional
`Agent.runtime_availability` summary as false, while native presence derives
liveness from the bound runtime. Reuse `deriveAgentPresenceDetail` with the
runtime already returned by the same load, and forward runtime-cache
invalidation. No new status protocol or endpoint is introduced. A regression
covers both a missing summary with an online runtime and a stale online
summary with an offline runtime. `11-after-agent-menu.png` confirms the fix.

### Changes and reuse

- `conversation-flow-page.tsx`: shared InputGroup/IconButton search controls,
  loading feedback, clear/no-results states, compact navigation, bounded grid.
- `chat-thread-list.tsx`: optional search and empty content; filter the displayed
  rows without replacing the canonical archive set or changing selection.
- `chat-session-header.tsx`: optional leading slot. Original Chat omits it.
- `composer-footer-controls.tsx`, `multica-components.css`: existing public
  dropdown primitives, current-value descriptions, readable width and semantic
  typography/color tokens. Host-only selectors cover the source render-slot
  boundary and disabled Handoff, which parent native components cannot style.
- Existing en/zh-Hans/ja/ko chat dictionaries receive the new labels.

### Verification

All commands ran from the repository root. Logs are under
`.tmp/conversation-ui-polish/`.

```sh
pnpm --filter @multica/views exec vitest run tutti-agent-gui chat/components/chat-thread-list.test.tsx chat/components/chat-session-header.test.tsx chat/floating-chat-visibility.test.ts chat/chat-page.test.tsx chat/components/chat-input.test.tsx chat/components/use-chat-controller.test.tsx
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/views typecheck
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/views exec eslint tutti-agent-gui/conversation-flow-page.tsx tutti-agent-gui/conversation-flow-page.test.tsx tutti-agent-gui/parent-service.ts tutti-agent-gui/parent-service.test.ts chat/components/chat-thread-list.tsx chat/components/chat-thread-list.test.tsx chat/components/chat-session-header.tsx
pnpm --filter @multica/tutti-agent-gui-host build
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-agent-gui.spec.ts --trace retain-on-failure'
pnpm --filter @multica/desktop build
node vendor/tutti/sync.mjs --verify
git diff --check
```

Results: 191 Views tests and 30 host tests passed; full interaction E2E passed
in 51.7 seconds. Both package type checks, scoped lint, host/desktop builds,
vendor verification (2,491 upstream files unchanged; 22 metadata overlays)
and diff checks passed. The desktop build retains an existing mixed static /
dynamic import warning for the emoji picker.

E2E covers 1440/1024/900/390 widths in light and dark, no horizontal overflow,
search/clear/return, mounted iframe and unsent draft retention during compact
navigation, menu keyboard/focus/radio behavior, model persistence, references,
attachments/cancel/resend and original Chat independence. Native screenshots
were taken after the build and managed desktop restart. Original Chat was
also inspected (`14-native-chat-after.png`). The temporary light preference
was restored to Follow system. `17-final-desktop.png` confirms the final wide
window after restoration and the last managed restart.

No real model inference was used in this UI pass. Codex execution remains
covered by the previous two-pane acceptance. Claude Code was not invoked.

### Limits

Search covers title, Agent name and last-message text, rather than all historic
messages. Rich-text drafts still follow the existing mounted GUI lifetime;
compact return preserves them, but cross-tab unmount persistence is unchanged.
Screenshots and keyboard checks do not establish full screen-reader compliance.
No installer signing or release was performed.

## Captured walkthrough

Current-run captures are shown in the same order as the five audited steps.

1. Find a conversation — good: visible search and selected-row hierarchy.

![Conversation search](../../.tmp/conversation-ui-polish/13-after-desktop-light.png)

2. Choose an Agent — good: readable names, liveness and switch consequence.

![Agent menu](../../.tmp/conversation-ui-polish/11-after-agent-menu.png)

3. Choose a model — good: default, choices and conversation scope are readable.

![Model menu](../../.tmp/conversation-ui-polish/12-after-model-menu.png)

4. Read in a narrow window — good: single header, clear return arrow, input actions visible.

![Compact conversation](../../.tmp/conversation-ui-polish/15-after-compact-restart.png)

5. Return from a no-results list — good: clear and return actions remain available.

![Search recovery](../../.tmp/conversation-ui-polish/07-after-search-empty.png)

Before/after comparison and visual acceptance: `design-qa.md` at the repository
root. The previous two-pane report is preserved in
`docs/engineering/conversation-flow-two-pane-design-qa.md`.
