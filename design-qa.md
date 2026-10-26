# Side workspace design QA

final result: passed

## Visual truth and implementation

This pass implements the approved Side/resource workspace concept, keeping the existing Multica desktop framework. The earlier UI-polish report is preserved at `docs/engineering/conversation-ui-polish-design-qa.md`.

Source visual truth files:

- Selection/Side: `/Users/zhengweibin/.codex/generated_images/01a16912-dd21-7252-af84-cfde086e344d/exec-34647add-88e6-464d-929b-8555407df515.png`
- Queue/Side: `/Users/zhengweibin/.codex/generated_images/01a16912-dd21-7252-af84-cfde086e344d/exec-425d78d1-32ff-4d20-b5d5-e6de0cf1bb87.png`
- Shared resource + menu: `/Users/zhengweibin/.codex/generated_images/01a16912-dd21-7252-af84-cfde086e344d/exec-a8b24e87-be7c-4782-9a6c-8964d45bd137.png`
- File preview: `/Users/zhengweibin/.codex/generated_images/01a16912-dd21-7252-af84-cfde086e344d/exec-cd009597-eb06-4818-8ea6-1864fc10c948.png`

These are approved conceptual references based on Multica screenshots and the user's description of Codex behavior. No Codex app-window inspection or pixel-exact Codex fidelity is claimed.

Implementation is the actual Multica Canary multica-925-cloud Electron app, renderer `http://localhost:16099/`. The light final native screen is `.tmp/side-design/18-native-balanced-light.png`; the final restart/follow-system screen is `.tmp/side-design/21-native-restart-final.png`. File preview is `.tmp/side-design/06-native-file-light.png`. Browser-rendered production-workspace evidence is `.tmp/side-design/12-rendered-workspace-wide.png`, `13-rendered-workspace-expanded.png`, and `14-rendered-workspace-narrow.png`.

## Normalization and state

Concept files are 1586 × 992 pixels. They have no inspectable CSS viewport/density; use their full conceptual canvas rather than inventing exact CSS measurements. Native captures are 3024 × 1898 pixels from a 1512 × 949 logical desktop viewport at 2× density. Full comparisons downsample both images to 1400 pixels wide, maintaining aspect ratio, with a 32-pixel evidence label. Full-view comparison evidence: `.tmp/side-design/19-final-comparison.png`.

The final light comparison has the full existing Multica navigation, a source Codex conversation and an empty quoted Side, with both composers docked at the bottom. The main/Side ratio is 54.439% / 45.561% within the detail region. Concept illustrative task titles and long sample answers are replaced by existing real local test conversation content. The selection toolbar closes after Side creation, so the final capture intentionally shows the resulting state; its open state is verified in GUI E2E and native selection acceptance. App tabs and session counts differ with real data.

Focused comparison `.tmp/side-design/20-final-focused.png` places the actual right-workspace content region and concept right region together at 650 pixels wide. Native crop is `(2099,177)-(3024,1898)`; concept crop is `(1035,85)-(1586,992)`. This is a relative-content comparison, not a pixel-diff. File full/focused evidence is `.tmp/side-design/08-file-comparison.png` and `08-file-comparison-focused.png`.

Browser fixture captures use the real production LocalSideWorkspace and file preview, with a test-owned IPC fixture. Wide viewport is 1200 × 900 at 1×; narrow is 620 × 800 at 1×. Fixture controls above the workspace are test chrome, not product UI. No alternate mock implementation is used.

## Findings, fixes and comparison history

1. **P2 — Cropped home carousel in Side.** Baseline `.tmp/side-design/01-native-before.png` and combined comparison `02-before-comparison.png` show a floating vinyl fragment. The carousel is a sibling of the hidden hero body. Hide both only in Side documents. Native post-fix `04-native-side.png` and final `18-native-balanced-light.png` show no fragment; the main welcome art remains unchanged.
2. **P2 — Selected overflow tab offscreen.** Opening a third resource selected its content while leaving the active tab outside the strip. Scroll the selected tab wrapper into view on selection/open. Final file evidence `06-native-file-light.png` and browser `12-rendered-workspace-wide.png` show the selected resource. Browser test asserts the selected tab is inside its scroll strip.
3. **P2 — Empty quoted Side lacked orientation.** Add a muted standard icon and the approved follow-up hint without changing the transcript/composer. Final `18-native-balanced-light.png` and `20-final-focused.png` show the source quote, locator and hint.
4. **P1 — New hint wrapper broke dock height.** Intermediate `10-native-side-expanded.png` shows the input above the empty canvas. Add the missing flex-column layout to the wrapper. Revised `11-native-expanded-fixed.png`, `18-native-balanced-light.png` and final focused comparison place input at the bottom.
5. **P1 — Hidden panels and separator registration.** The library's inline flex display overrode native hidden presentation, and a separator initialized beside a hidden panel could throw “Matching panels not found” during keyboard resizing. Apply a workspace-scoped explicit hidden rule and mount the separator only while both panels are visible; keep GUI panels mounted. The browser regression reproduced the error before the registration fix. Final combined 25-test run passes resize/expand/restore/close/narrow behavior and checks zero page errors. Native keyboard resize changes the divider from 34.439 to 54.439; full post-fix evidence is `18-native-balanced-light.png`.

Intermediate screenshots are retained as diagnostic evidence; only post-fix evidence is accepted. The final full and focused comparisons were opened together with their source targets after the fixes. No actionable P0/P1/P2 issue remains in this scope.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Uses Multica's existing font stack and role-based title/body/label/caption tokens. Side provenance is muted, quotation is body text, resource names truncate without shifting controls. Input/body hierarchy and line height are readable in native light/dark and focused comparisons. No new display face. |
| Spacing and layout | Existing shell and session list remain. 48px resource header, shared tab strip, narrow source row, bottom composer and resizable split follow the concept hierarchy. Expansion hides the main detail region; return restores it. Narrow mode keeps persistent actions visible. |
| Colors and visual tokens | Existing background, border, selected surface, muted foreground, accent and focus tokens are used in both themes. Active tabs use a visible underline rather than a new palette. The main message bubble retains existing Multica color treatment. |
| Image quality and assets | Existing provider brand assets remain unchanged in the session list/main home. UI controls and the empty-state mark use the existing public Lucide icon library. There is no recreated illustration, custom logo or CSS artwork. Webpages/images display actual resource content. |
| Copy and content | Chinese/English labels cover source location, new Side, resource opening, expand/restore, return and pending-message recovery. The quote is the user's actual selected text. Compact provenance replaces the conceptual nested card to avoid redundant framing in the existing Multica hierarchy. |

Intentional product constraints: the current plain monospaced read-only code preview has line numbers and targeted-line highlighting but no syntax colors or editor tools. Existing main toolbar/Fork controls are retained; conceptual Share actions were not invented. Side inherits the source provider while allowing independent model selection. These are documented scope choices, not unimplemented core navigation.

## Interaction acceptance

- Native selected-text toolbar creates a saved Side and carries source turn/quote without sending a model request.
- Queue transfer is verified for Codex and Claude with fake execution; main execution continues and transferred prompts cannot replay on main.
- Native right + menu creates Side; separate drafts survive panel close/reopen.
- Source link selects the original conversation and locates its text; virtual locator integration is covered by the existing turn mapping hooks.
- Native folder picker, file tree and code preview work. Native webpage loads, and parent menus remain usable above it.
- Real browser production component verifies overflow tabs, keyboard resizing, expanded/split mode, complete closure, narrow return and unchanged main draft.
- Final desktop restart restores two Side tabs, selected quote/provenance and the granted folder/file preview. Original follow-system theme is restored.

## Validation and limits

- Desktop: 76 targeted unit/component tests passed.
- Host: 57 unit/runtime tests passed.
- Final GUI suite: 25 passed in 36.2s (`.tmp/side-all-final.log`). The new production-workspace case checks page errors; zero were observed.
- Native isolated preview integration passed: no require/process/desktopAPI, correct bounds/history/scope/close; zero model calls.
- Desktop and host type checks passed. Scoped desktop lint is clean. Host lint completed with zero errors and two existing hook warnings. Desktop/host builds passed, retaining the existing mixed emoji-picker import warning.
- `git diff --check` passed.

No real model quota was consumed in this Side acceptance. Windows/Linux native windows, arbitrary third-party sites, signed installer release and exhaustive screen-reader testing are not covered. Unsent draft persistence across process restart is not promised; saved Side metadata/history and layout are durable.

## Implementation checklist

- [x] Three approved Side entry points and persisted source context.
- [x] Shared folder/file/web workspace with keyboard and overflow behavior.
- [x] Main execution/draft preservation and queue ownership recovery.
- [x] Light/dark native comparisons, targeted fixes and post-fix evidence.
- [x] Production layout, host GUI, native preview and desktop restart validation.


## Selected-text toolbar follow-up

The user's cropped dark screenshot exposed a currentColor border: the toolbar inherited the white text foreground. Browser tests reproduced the border/foreground equality in both themes. The toolbar now uses the existing surface-border and menu-shadow tokens, 24px shared ghost buttons, 14px icons and measured edge-aware positioning. Native post-refresh evidence is `.tmp/side-design/selection-toolbar-native.png` with detail crop `selection-toolbar-native-detail.png`; light/dark browser evidence is `selection-toolbar-light.png` and `selection-toolbar-dark.png`. The revised surface is compact with a subtle border and the Side-tab conversation icon. Existing selection and invocation labels remain.

All 11 queue/selection GUI tests passed. Additional edge placement checks cover top/right selections in a narrow viewport. Host typecheck, scoped lint, host build and desktop build passed. The existing desktop emoji-picker build warning remains. No real model call was made. The full desktop was refreshed and the selected reply toolbar visually inspected.

## Side visibility follow-up

Side conversations now remain in the right workspace. The left list previously admitted every Side through its `messages.length > 0 || side` predicate. The list projection now excludes Side metadata before project grouping, so search, archives and counts also exclude them. The full session query remains unchanged for right tabs, source navigation, saved history and queue ownership. Ordinary Fork sessions remain listed.

The new component regression first reproduced two visible Side rows for each provider. It now passes for Codex and Claude, covering empty/executed/archived Sides, project counts, search, persisted right tabs, quoted context, source navigation and ordinary Fork visibility. All 37 tests in `local-conversation-flow.test.tsx` and `local-side-workspace.test.tsx` pass. Renderer typecheck, scoped ESLint, desktop build and `git diff --check` pass. Logs: `.tmp/side-list-before.log`, `.tmp/side-list-tests.log`, `.tmp/side-list-types.log`, `.tmp/side-list-lint.log` and `.tmp/side-list-build.log`.

Native inspection was attempted after the change, but the desktop inspection tool returned a blank capture and only the window container, including after a standard Reload. No final native visual acceptance is claimed for this follow-up. The application renderer service remains running; component acceptance uses the production page and right workspace. No model request or data deletion was performed.

## Click to enlarge SVG

The SVG sandbox previously rendered a passive image; the existing toolbar only changed inline height. Clicking the image now requests a large top-layer preview over the conversation pane, through the existing source/origin/channel-checked preview messages. The SVG uses a native button for mouse and keyboard entry. The native dialog retains the original iframe and reserves its inline layout. Shared Multica buttons, colors, borders and radius remain in use. Close, backdrop click and Escape from either the host controls or SVG document return to the inline image and restore focus to the expand control.

The regression first failed for both providers because clicking the image opened no dialog. Final `e2e/agent-html-preview.spec.ts` passes all 8 cases in 12.5s, covering repeated entry, keyboard entry, close/backdrop/Escape, retained document marker, retained 125%/150% zoom, unchanged following-text position, dark/light themes and Chinese labels. Existing HTML interaction, chart rendering, streaming, invalid SVG and isolation cases also pass. An intermediate run overlapped desktop asset copying and hit a chart asset load failure; final acceptance ran after the build finished. Expansion requests no longer depend on the sandbox's asynchronously updated presentation flag, so immediate re-entry is accepted.

The 6 document/code-block unit tests, host typecheck, scoped ESLint, host/desktop builds and `git diff --check` pass. The existing desktop emoji-picker import warning remains. Evidence: `.tmp/local-conversations/svg-{codex,claude}-expanded{,-light}.png`; final run log `.tmp/svg-enlarge-final.log`. Both final theme captures were visually inspected. Tests use synthetic provider replies and consume no real model quota. This acceptance is browser-based with production GUI assets; no native desktop-window acceptance is claimed.

### Native follow-up: current window retained the previous GUI

The user's no-effect report was reproduced in the actual `Multica Canary multica-925-cloud` window: the SVG accessibility tree exposed only a passive image and clicking it changed nothing. The built assets already contained the new implementation. `tutti-agent-gui-panel.tsx` deliberately retains its iframe document for the host lifetime, so rebuilding static assets alone does not replace an already-open GUI. After confirming there was no running task or unsent text, a standard View → Reload created a new GUI connection. The SVG then exposed the new expand button. Clicking the user's existing workflow opened the large preview with the actual full diagram, and Escape returned to the inline card with focus restored to Expand preview. Native evidence: `.tmp/local-conversations/svg-native-expanded.png`. No application code, conversation data or model requests changed in this follow-up.

### Default flowchart format

The shared preview instructions now default flowcharts and workflow/process diagrams to self-contained SVG fences, respecting explicit requests for other formats. Interactive visualizations retain HTML support. The existing service/runner suites pass all 34 tests, including injection of this rule into new and resumed Codex/Claude executions. Desktop build and `git diff --check` pass. Logs: `.tmp/svg-default-tests.log` and `.tmp/svg-default-build.log`. The cloud development app was restarted with the updated bundled main process; the existing conversation and clickable workflow SVG restored in the native window. No real model request was sent.

## Global SVG popup

The previous dialog lived inside the GUI iframe and was bounded by the conversation column. `AgentGuiPreviewHost` now promotes the owning GUI frame into the application document's native top layer when the SVG popup opens. The same GUI frame and opaque SVG document remain mounted. During expansion, the GUI canvas becomes transparent/hidden except for the open preview, so the backdrop covers the existing app shell. Closing restores the column dimensions, main draft and SVG zoom. The existing native preview pattern is used to avoid portal-induced iframe reloads; no new dependency or business RPC is added.

Only the exact owning frame and same-origin versioned preview-state packet can change global state. Current account/workspace and active-tab guards apply. Hidden hosts, invalid scope, unsupported packets, host Escape and GUI document reload are covered in component tests. Native webpage overlays now observe role/open mutations so they hide above a popup and restore afterward.

Validation: 11 shared host/panel component tests and 3 desktop resource-workspace tests pass. All 10 HTML/SVG GUI E2Es pass in 16.4s (`.tmp/svg-global-final.log`), including real production global host plus built GUI for both providers. Follow-up source-switch/focus assertions also pass (`.tmp/svg-global-focus.log`). The global cases assert full viewport bounds, same-frame/document retention, restored dimensions, preserved zoom/draft, narrow viewport and backdrop/Escape dismissal. Desktop renderer and GUI typechecks, scoped lint, desktop build and diff whitespace check pass. Existing emoji-picker build warning remains.

Native acceptance uses the actual existing workflow SVG in `Multica Canary multica-925-cloud`: clicking the visible diagram covers the full app window including sidebar and tab strip; Escape restores the conversation layout. Evidence: `.tmp/local-conversations/svg-native-global.png`. Browser fixture evidence: `svg-{codex,claude}-global.png`. These screenshots were visually inspected. No real model request was sent; Windows/Linux native windows are not covered.
