import { useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { ConversationListModel } from "@multica/conversation-client/models";
import type { ConversationService } from "@multica/conversation-client/services";
import { localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { NavigationProvider, type NavigationAdapter } from "@multica/views/navigation";
import { ContextMenu, ContextMenuContent, ContextMenuItem } from "@multica/ui/components/ui/context-menu";
import { DropdownMenuItem } from "@multica/ui/components/ui/dropdown-menu";
import { LocalConversationSortableList } from "../../src/renderer/src/pages/local-conversation-sortable-list";
import { LocalConversationSessionRow } from "../../src/renderer/src/pages/local-conversation-session-row";
import { LocalConversationListModel } from "../../src/renderer/src/platform/local-conversation-list-model";
import { orderLocalConversations, reorderLocalConversations, type ConversationOrder } from "../../src/renderer/src/platform/local-conversation-order";
import { conversationOrderGroupKey, conversationOrderScopeKey, useConversationOrderStore } from "../../src/renderer/src/stores/local-conversation-order-store";
import type { LocalSessionEntry } from "../../src/renderer/src/platform/local-conversation-projects";
import chat from "../../../../packages/views/locales/en/chat.json";
import "../../src/renderer/src/globals.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const scopeKey = conversationOrderScopeKey({ apiUrl: "https://test.invalid", userId: "test", workspaceId: "test", deviceId: params.get("device") ?? "local" });
const source = new ConversationListModel();
source.upsert(["Pinned", "First", "Second", "Third", "Other A", "Other B"].map((title, index) => localV2SummarySchema.parse({
  conversation_id: title, title, summary_seq: 1, provider: index % 2 ? "codex" : "claude", pinned: index === 0, archived: false, status: "idle", turn_count: 1,
  last_message_preview: `Preview for ${title}`, last_turn_sent_at: `2026-11-15T00:00:0${6 - index}Z`, updated_at: "2026-11-15T00:00:00Z",
})));
const model = new LocalConversationListModel(source);
const adapter: NavigationAdapter = { push: () => {}, replace: () => {}, back: () => {}, pathname: "/conversations", searchParams: params, hash: "", getShareableUrl: (path) => path };
const t = ((selector: (resource: typeof chat) => string) => selector(chat)) as ComponentProps<typeof LocalConversationSessionRow>["t"];
const empty: Record<string, ConversationOrder> = {};

const Fixture = observer(function Fixture() {
  const [selected, setSelected] = useState<string | null>("First");
  const [selections, setSelections] = useState(0);
  const [menu, setMenu] = useState("");
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const orders = useConversationOrderStore((state) => state.ordersByScope[scopeKey] ?? empty);
  const row = (entry: LocalSessionEntry) => <ContextMenu key={entry.id}>
    <LocalConversationSessionRow
      id={entry.id} model={model} selected={selected === entry.id} sessionLinks={links} flowPath="/conversations"
      select={(id) => { setSelected(id); setSelections((count) => count + 1); }} updatingId={null} labels={{ pinned: "Pinned", storage: "Saved locally" }}
      projectLabels={{ actions: "Conversation actions" }} t={t} setContextSelection={() => {}} chinese={false} remote={false}
      v2={{ list: source } as ConversationService}
      renderSessionActions={() => <DropdownMenuItem onClick={() => setMenu(entry.id)}>Menu action</DropdownMenuItem>}
    />
    <ContextMenuContent><ContextMenuItem>Copy</ContextMenuItem></ContextMenuContent>
  </ContextMenu>;
  return <NavigationProvider value={adapter}>
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <aside className="w-[310px] max-w-full space-y-4 rounded-lg border p-2">
        {["Project", "No project"].map((group, index) => {
          const entries = model.sessions.filter((entry) => entry.id.startsWith("Other") === (index === 1));
          const key = conversationOrderGroupKey(group);
          const sessions = orderLocalConversations(entries, orders[key]);
          return <section key={group} aria-label={group}>
            <h2 className="mb-2 px-3 text-body font-medium">{group}</h2>
            {params.has("baseline") ? <div className="flex flex-col gap-1">{sessions.map(row)}</div> : <LocalConversationSortableList
              groupId={group} sessions={sessions} renderSession={row} chinese={false}
              reorder={(_group, active, over) => {
                const order = reorderLocalConversations(entries, orders[key], active, over);
                if (order) useConversationOrderStore.getState().setOrder(scopeKey, group, order);
              }}
            />}
          </section>;
        })}
      </aside>
      <output aria-label="Navigation count">{selections}</output>
      <output aria-label="Menu result">{menu}</output>
    </main>
  </NavigationProvider>;
});
const root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Fixture />);
