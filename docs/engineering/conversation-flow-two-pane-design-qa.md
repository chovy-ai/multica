# Conversations two-pane design QA

final result: passed

## Target and normalization

User screenshot:
`/var/folders/r2/742l1bhx29q93tl07lx0y59c0000gn/T/codex-clipboard-64b11cc5-07b1-4d93-8420-41c41fc369fc.png`

The target is its left-session / right-conversation composition. The user
explicitly keeps the existing Tutti conversation content and requests Agent
and model selectors at the bottom right. Native Chat's transcript renderer is
therefore a composition reference, rather than a requested replacement for
Tutti's transcript. The original Chat remains independent.

Source: 2526 × 1876 pixels; desktop: 3024 × 1898 pixels at 2× density, with a
1512 × 949 CSS-pixel window. The source already omits the app sidebar. For a
matching content comparison, crop the source to `(16,28)-(2510,1833)` and the
desktop to `(515,80)-(3010,1885)`: 2494 × 1805 and 2495 × 1805 pixels. Compare
both at 1024-pixel width. Do not interpret window chrome, a different number
of saved sessions, timestamps, or the additional task-reference turn as
fidelity defects. Both captures select the original Codex history; the final
capture also contains the later verification session in the list.

## Comparison loop

1. Opened the supplied screenshot and the native desktop implementation.
   Compared them together in
   `.tmp/multica-gui-restoration/two-pane-qa-initial-comparison.png`.
2. Initial result: blocked. P2: the existing floating Chat launcher obscured
   the new Agent selector in the bottom-right corner. P2: source window capture
   protection blocked click events on the new menu portals. The page also had
   two state-recovery gaps: a failed member query had no retry affordance, and
   a late create response could override a newer session selection.
3. Applied scoped fixes: reuse the floating-overlay route gate for
   Conversations and its shortcut, add the source's existing `.nodrag` menu
   boundary, include membership-query recovery, and guard delayed creation by
   selection intent. The visible current session uses the existing read
   mutation after its latest message arrives.
4. Rebuilt the desktop, restarted it, captured the revised implementation and
   compared it together with the supplied screenshot in
   `.tmp/multica-gui-restoration/two-pane-qa-final-comparison.png`.
   The selectors are clear and clickable; no actionable P0/P1/P2 difference
   remains within the requested composition and retained-content scope.

## Visual findings after fixes

| Area | Result |
| --- | --- |
| Composition | Two columns; session list 38.5%, matching native Chat's 38.523% saved layout at this viewport; no extra provider or project rail |
| List and header | Reuse native avatar, title, preview, unread, hover actions and heading components; native Chat links are explicitly overridden for Conversations |
| Typography | Multica's semantic font roles retained; source composer and transcript keep their requested density |
| Color and states | Native selected/hover tokens and source semantic token mapping verified in light and dark; focus indicators remain visible |
| Footer | Existing attachment/reference controls at left; model and Agent controls at right; no floating overlay, duplicate model picker, clipping or overlap |
| Menus | Real mouse selection, radio state, keyboard traversal, Escape and focus return pass; model catalog uses real runtime labels |
| Responsive | 1440/1024 two-pane and 900/390 compact modes pass; compact list navigation and resizing retain the same iframe and draft |
| Assets and copy | Existing Agent avatars and public UI System icons reused; Agent switch consequence appears in its menu |
| Original Chat | Native presentation and selected history confirmed independently after desktop restart |

## Evidence

All files below are under `.tmp/multica-gui-restoration/`:

- `38-two-pane-after-restart-light.png`: rebuilt desktop, light theme.
- `39-two-pane-after-restart-system.png`: rebuilt desktop, restored system
  theme (currently dark). The temporary light-theme preference was reverted.
- `32-two-pane-native-agent-picker.png` and
  `33-two-pane-native-model-picker.png`: actual desktop menus.
- `34-two-pane-native-final.png`: two completed real model-verification turns.
- `37-native-chat-unchanged.png`: original Chat after desktop restart.
- `36-two-pane-iab.png`: live Web route checked in the in-app browser; the
  temporary preview tab was closed afterwards.
- `two-pane-{dark,light}-{1440,1024,900,390}.png`: responsive E2E states.
- `two-pane-e2e.log`: full interaction regression, 1 passed in 43.1 seconds.
- `two-pane-real-codex-models.json`: both runs completed, no tool calls, same
  provider session; `gpt-6-luna` then configured default `gpt-6.1-sol`, with no
  change to the Agent's stored model.

343 targeted TypeScript tests passed (187 Views, 126 Core API, 30 host).
Relevant backend tests, type checks, scoped lint, desktop build, vendor sync
verification and diff checks passed. Detailed commands and execution boundaries
are in `docs/engineering/conversation-flow-two-pane.md`.

## Scope limits

The retained Tutti transcript/composer deliberately differs from native Chat's
message spacing and input-card geometry. Agent changes start a fresh
conversation scope and do not transfer its original draft or attachments.
Upstream rich-text drafts follow the mounted GUI lifetime; persisted model
preferences do not introduce cross-tab draft persistence. Real execution was
checked with Codex only, as requested. No installer signing or release was in
scope.
