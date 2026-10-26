const SKELETON_ROWS = [
  { id: "first", size: "long" },
  { id: "second", size: "medium" },
  { id: "third", size: "short" },
  { id: "fourth", size: "medium" },
  { id: "fifth", size: "long" }
] as const;

interface AgentConversationListSkeletonProps {
  label: string;
}

export function AgentConversationListSkeleton({
  label
}: AgentConversationListSkeletonProps): React.JSX.Element {
  "use memo";
  return (
    <div
      className="agent-gui-node__conversation-list-skeleton"
      role="status"
      aria-label={label}
      data-testid="agent-gui-conversation-list-loading-skeleton"
    >
      {SKELETON_ROWS.map((row) => (
        <div
          key={row.id}
          className="agent-gui-node__conversation-list-skeleton-row"
          data-size={row.size}
          aria-hidden="true"
        >
          <span className="agent-gui-node__conversation-list-skeleton-spine" />
          <span className="agent-gui-node__conversation-list-skeleton-rib agent-gui-node__conversation-list-skeleton-rib-primary" />
          <span className="agent-gui-node__conversation-list-skeleton-rib agent-gui-node__conversation-list-skeleton-rib-secondary" />
        </div>
      ))}
    </div>
  );
}
