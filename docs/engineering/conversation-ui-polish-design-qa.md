# Conversation UI polish design QA

final result: passed

## Scope and target

Current request: improve UI interaction without changing the Multica framework.
The current-run baseline, rather than a new mockup, is the comparison target.
Keep two columns, original Chat independence, Tutti transcript/composer behavior,
attachment/reference actions and the actual Multica Agent execution path.

The preceding two-pane QA is preserved in
`docs/engineering/conversation-flow-two-pane-design-qa.md`. Its 38.5% list
geometry describes that earlier acceptance; the current pass deliberately
uses a narrower bounded list.

## Comparison and iteration

All evidence is under `.tmp/conversation-ui-polish/`.

1. Captured and inspected `01-before-desktop.png` through
   `05-before-compact-list.png` in the actual development Electron app.
2. Found five actionable interaction issues: missing conversation search,
   unreadably narrow Agent and model menus, duplicated compact headers, and
   no direct return from the compact list. The footer also exposed a disabled
   Handoff control. Applied fixes at the existing parent/header/render-slot
   boundaries.
3. First native inspection of the Agent status addition found an incorrect
   offline label. Evidence: `08-after-agent-menu.png`. This intermediate image
   is not an accepted final menu. The source adapter read only an optional
   summary field; native presence uses bound-runtime liveness. Reused the
   existing pure presence derivation and verified both stale and absent
   summary cases. Also corrected left alignment.
4. Built the desktop, restarted the managed development app and inspected
   `10-after-desktop.png`, `11-after-agent-menu.png`,
   `12-after-model-menu.png`, `13-after-desktop-light.png` and
   `15-after-compact-restart.png`. Verified the original Chat independently in
   `14-native-chat-after.png`. Restored Follow system theme after the light
   check.
5. Compared baseline and final screenshots together in the four paired images
   below. No actionable P0/P1/P2 issue remains within this scoped UI pass.
   A stale compositor image during macOS window restoration is retained as
   `debug-resize-compositor-not-accepted.png`; it is excluded from acceptance.

## Normalization

Desktop baselines are 3024×1898 pixels; the rebuilt native captures are
3024×1900. Crop only the final two bottom pixels to the common 3024×1898
canvas, then scale both sides identically to 1150 pixels wide. All desktop
comparisons select the same original Codex session and history. Menu pairs
show the same open menu and model/Agent values. Cursor highlights, tab hover
chrome and timestamps are not design differences.

Compact baseline and rebuilt final are both 1922×2100 pixels. Scale both to
720 pixels wide without cropping. The final back arrow is unobscured. Search
recovery is a separate interaction state, not a pixel-fidelity comparison
against an unfiltered list.

Focused menu comparisons use the same `(2200,1000)-(3024,1898)` bottom-right
crop on each original, preserving native 2× density and readable menu text.
Desktop CSS size is 1512×949/950 before normalization; compact CSS size is
961×1050, both at density 2. The selected conversation, theme and menu state
match within each pair. `17-final-desktop.png` additionally confirms a clean
wide-window render after the final managed restart.

## Findings and checks

| Area | Final evidence and assessment |
| --- | --- |
| Overall layout | Existing two-pane grid and navigation remain. List uses min 260px, 28%, max 360px; transcript gains reading width. At this native viewport the list is about 349 CSS px. |
| Session discovery | Search title, Agent and last-message text; no-results clear action, Escape/focus return, preserved archive view. Filtering does not replace canonical sessions or change selection. |
| Compact hierarchy | One 48px header with leading back action; direct return action in list. Same iframe identity and unsent rich-text draft survive list navigation and resize in E2E. |
| Agent menu | 300px viewport-bounded width, names and status left-aligned, current radio indicator, consequence after choices. Real Codex header and menu both show online. |
| Model menu | Default label fits one line; bounded scrolling, runtime labels, IDs in tooltips, current-value description and conversation-scope help. Existing loading/error/retry/unsupported states remain. |
| Assets / image quality | Existing Agent avatars and public library icons remain sharp at native 2× density. No generated assets, custom icon drawings or new image treatments were introduced. |
| Copy / content | Added Chinese/English search recovery and model-scope labels are product copy, with Japanese/Korean list labels. Agent-switch consequence follows the choices. Saved test prompts are existing conversation content. |
| Spacing / surfaces | Existing native input radius, border, padding and selected-row surface are reused. Menu content fits its viewport-bounded width and scroll area. Compact header removes one 48px row without changing transcript rhythm. |
| Input actions | Attachment and reference actions remain. Only disabled Handoff in conversation presentation is hidden; enabled source behavior is untouched. |
| Typography / colors | Existing Multica semantic tokens and mapped public UI primitives; title, body, muted caption and focus hierarchy inspected in light/dark. No new palette or assets. |
| Focus / states | Search has a programmatic name; clear and return are named controls. Real menu radio state, keyboard traversal, Escape and focus restoration pass. No horizontal page/frame overflow at four tested widths. |
| Native Chat | Original layout, current selection and renderer remain independent after restart; new shared header/list props default to existing behavior. |

## Paired visual evidence

![Desktop before and after](.tmp/conversation-ui-polish/qa-desktop-comparison.png)

![Agent menu before and after](.tmp/conversation-ui-polish/qa-agent-menu-comparison.png)

![Model menu before and after](.tmp/conversation-ui-polish/qa-model-menu-comparison.png)

![Compact view before and after](.tmp/conversation-ui-polish/qa-compact-detail-comparison.png)

![Agent menu focused comparison](.tmp/conversation-ui-polish/qa-agent-menu-focused.png)

![Model menu focused comparison](.tmp/conversation-ui-polish/qa-model-menu-focused.png)

## Verification

- 191 Views tests and 30 host tests passed.
- Full interaction E2E: 1 passed in 51.7 seconds. Light/dark at
  1440/1024/900/390; search, clear, return, drafts, keyboard menus, model
  persistence, references, attachment cancellation/resend, original Chat.
- Views/host TypeScript checks, scoped ESLint, host build and desktop build
  passed. Existing mixed static/dynamic emoji-picker import warning remains.
- Vendor verification: 2,491 upstream files unchanged and 22 metadata overlays.
  No new dependency, backend change or source-vendor edit for this UI pass.
- `git diff --check` passed. Commands and the five-step walkthrough are in
  `docs/engineering/conversation-ui-polish.md`.

## Limits

Search covers recent preview text, not a full historical message index.
Rich-text draft lifetime remains the mounted GUI lifetime; cross-tab unmount
persistence is unchanged. This pass does not claim a full screen-reader audit.
No real model inference was needed; prior Codex execution acceptance remains
applicable, and Claude Code was not invoked. Installer signing/release is
outside this pass.

## Implementation checklist

- [x] Inspect current desktop flow and save baseline evidence.
- [x] Apply scoped search, hierarchy, menu and status fixes.
- [x] Inspect final full-view and focused before/after pairs.
- [x] Complete automated interaction regression, checks and desktop build.
- [x] Restore system theme and inspect the final wide desktop window.
