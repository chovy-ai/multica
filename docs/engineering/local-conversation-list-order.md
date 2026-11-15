# Desktop conversation list order

Conversation summaries remain in the MobX `ConversationListModel`. The desktop
list derives its default order from pin status, the latest user turn's send
time, and ID. Folder grouping follows execution directories; cloud project
associations are independent.

The desktop supports manual ordering through a drag handle, using dnd-kit.
Space starts a keyboard move, arrow keys move it, Space drops it, and Escape
cancels. Each visible folder has its own drag context. Moves across folders or
between pinned and unpinned rows are rejected. The rest of each row retains its
navigation, menu and text-selection behavior.

Manual order is a display preference in the desktop Zustand store
`local-conversation-order-store.ts`, persisted under
`multica_local_conversation_order` in localStorage. It contains only IDs, with
separate pinned and unpinned sequences, scoped by API URL, account, workspace,
target device and visible folder group. All unassigned directories share the
visible "No project" group. Preferences survive renderer restarts but are not
shared with other viewing clients. No daemon schema or protocol changes are
required.

Until the first move, the default recency order applies. A successful move
records the complete group, including archived and currently paginated rows.
The saved order is applied before the eight-row page is selected. Search and
archive views filter that order without erasing hidden IDs. New conversations
appear first in their pin partition; activity on saved conversations does not
move them. Missing IDs have no effect on the displayed order and are discarded
the next time the group is reordered. Pinning a conversation takes priority
over its manual position.

Tests cover the ordering rules, persistence and scope isolation, page-hook
wiring, and pointer/keyboard interactions on the real sortable component and
session row in an isolated Chromium fixture. They do not execute a provider or
require PostgreSQL. The browser fixture can be served by a Vite server rooted
at the checkout, with React and Tailwind plugins enabled, then run with
`PLAYWRIGHT_BASE_URL=<fixture-origin> pnpm exec playwright test e2e/local-conversation-sortable-list.spec.ts`.
