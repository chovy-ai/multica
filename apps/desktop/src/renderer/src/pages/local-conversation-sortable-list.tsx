import { useId, type ReactNode } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors, type CollisionDetection } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import type { LocalSessionEntry } from "../platform/local-conversation-projects";

interface Props {
  groupId: string | null;
  sessions: LocalSessionEntry[];
  reorder(groupId: string | null, activeId: string, overId: string): void;
  renderSession(entry: LocalSessionEntry): ReactNode;
  chinese: boolean;
}

const samePinCollision: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  const bounds = args.droppableContainers[0]?.node.current?.parentElement?.getBoundingClientRect();
  if (pointer && bounds && (pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom)) return [];
  const pointed = pointerWithin(args)[0];
  if (pointed && args.droppableContainers.find((container) => container.id === pointed.id)?.data.current?.pinned !== args.active.data.current?.pinned) return [];
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => container.data.current?.pinned === args.active.data.current?.pinned),
  });
};

/** Each visible folder has its own context, so a drag never moves a conversation to another folder. */
export function LocalConversationSortableList({ groupId, sessions, reorder, renderSession, chinese }: Props) {
  const id = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={samePinCollision}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={({ active, over }) => {
        if (over && active.data.current?.pinned === over.data.current?.pinned) reorder(groupId, String(active.id), String(over.id));
      }}
      accessibility={{ screenReaderInstructions: { draggable: chinese
        ? "按空格键开始排序，按上下方向键移动，再按空格键放下，按 Esc 取消。"
        : "Press Space to start sorting, use the arrow keys to move, press Space to drop, or Escape to cancel." } }}
    >
      <SortableContext items={sessions.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1">
          {sessions.map((entry) => (
            <SortableRow key={entry.id} entry={entry} chinese={chinese}>
              {renderSession(entry)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ entry, children, chinese }: { entry: LocalSessionEntry; children: ReactNode; chinese: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    data: { pinned: entry.pinned },
  });
  return (
    <div
      ref={setNodeRef}
      data-sortable-session={entry.id}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 1 : undefined }}
      className={`group/sortable relative rounded-lg pl-4 ${isDragging ? "bg-background shadow-lg ring-2 ring-brand" : ""}`}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute left-0 top-1/2 z-10 w-4 -translate-y-1/2 touch-none cursor-grab text-muted-foreground opacity-0 focus-visible:opacity-100 active:cursor-grabbing group-hover/sortable:opacity-100"
        {...attributes}
        {...listeners}
        aria-label={chinese ? `调整会话顺序：${entry.title}` : `Reorder conversation: ${entry.title}`}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <GripVertical className="size-3" />
      </Button>
      {children}
    </div>
  );
}
