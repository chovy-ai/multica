import { GitFork, LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import { translate } from "../../../i18n/index";
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

export function AgentForkThroughTurnButton({
  disabled,
  pending = false,
  revealOnMessageHover = true,
  onFork
}: {
  disabled?: boolean;
  pending?: boolean;
  revealOnMessageHover?: boolean;
  onFork: () => void;
}): JSX.Element {
  const label = translate(
    pending
      ? "agentHost.agentGui.forkThroughTurnPending"
      : "agentHost.agentGui.forkThroughTurn"
  );
  return (
    <CanvasNodeGhostIconButton
      className={
        revealOnMessageHover
          ? styles.messageCopyButton
          : "static h-[22px] min-h-[22px] w-[22px] min-w-[22px] rounded-[5px]"
      }
      aria-busy={pending || undefined}
      aria-label={label}
      aria-live="polite"
      data-pending={pending || undefined}
      disabled={disabled || pending}
      onClick={onFork}
    >
      {pending ? (
        <LoaderCircle
          width={14}
          height={14}
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <GitFork width={14} height={14} aria-hidden="true" />
      )}
    </CanvasNodeGhostIconButton>
  );
}

export function AgentForkThroughTurnFooter({
  disabled,
  pending,
  onFork
}: {
  disabled?: boolean;
  pending?: boolean;
  onFork: () => void;
}): JSX.Element {
  return (
    <div
      className="mt-1 flex min-h-[26px] items-center"
      data-agent-turn-footer="true"
    >
      <AgentForkThroughTurnButton
        disabled={disabled}
        pending={pending}
        revealOnMessageHover={false}
        onFork={onFork}
      />
    </div>
  );
}
