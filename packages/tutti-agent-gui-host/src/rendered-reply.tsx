import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { AgentGuiRpcClient } from "./protocol";

interface Presentation {
  client: AgentGuiRpcClient;
  enabled: boolean;
  active: boolean;
  sessionId: string | null;
  toServerSessionId(id: string): string | null;
}
interface Message {
  isTurnFinalText?: true;
  sourceTimelineItems?: readonly {
    eventId: string;
    agentSessionId: string;
    messageSemantics?: { userVisibleAssistantResponse?: boolean; turnSettling?: boolean };
  }[];
}
const PresentationContext = createContext<Presentation | null>(null);

export function ReplyPresentationProvider({ children, ...value }: Presentation & { children: ReactNode }) {
  return <PresentationContext.Provider value={value}>{children}</PresentationContext.Provider>;
}

/** Mounted alongside the actual final text, never from a list or history load. */
export function RenderedReply({ message, children }: { message: Message; children: ReactNode }) {
  const presentation = useContext(PresentationContext);
  const reply = message.isTurnFinalText ? message.sourceTimelineItems?.findLast((item) =>
    item.messageSemantics?.userVisibleAssistantResponse === true && item.messageSemantics.turnSettling === true) : undefined;
  const sessionId = reply && presentation ? presentation.toServerSessionId(reply.agentSessionId) : null;
  const messageId = reply?.eventId;
  const active = presentation?.enabled === true && presentation.active && reply?.agentSessionId === presentation.sessionId;
  const client = presentation?.client;
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !client || !sessionId || !messageId || sent.current === messageId) return;
    // Schedule acknowledgement from the committed transcript, never its pending load.
    const frame = requestAnimationFrame(() => {
      sent.current = messageId;
      void client.request("session.markRead", { sessionId, messageId }).catch(() => {
        if (sent.current === messageId) sent.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, client, sessionId, messageId]);
  return children;
}
