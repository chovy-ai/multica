import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AgentGUIStartupShell } from "@tutti-os/agent-gui/startup-shell";
import { Button } from "@tutti-os/ui-system/components";
import { AgentGuiApplication } from "./application";
import { connectAgentGuiHost } from "./rpc-client";
import { createMulticaAgentGuiRuntime } from "./runtime";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import "@fontsource-variable/geist-mono";
import "./styles.css";

document.documentElement.classList.add("multica-agent-gui");
const root = createRoot(document.getElementById("app")!);

function RenderedView({ children }: { children: ReactNode }) {
  useEffect(() => {
    window.parent.postMessage({ type: "multica:agent-gui:rendered", version: 1 }, window.location.origin === "null" ? "*" : window.location.origin);
  }, []);
  return children;
}

function ErrorView({ error }: { error: Error }) {
  const chinese = document.documentElement.lang === "zh-CN";
  return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-[var(--text-primary)]">
    <p>{chinese ? "无法加载智能体界面" : "Could not load Agent GUI"}</p>
    <details className="max-w-full overflow-auto text-[var(--text-secondary)]"><summary>{chinese ? "错误详情" : "Error details"}</summary><pre className="whitespace-pre-wrap">{error.message}</pre></details>
    <Button onClick={() => window.location.reload()}>{chinese ? "重试" : "Retry"}</Button>
  </div>;
}

class AgentGuiErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Agent GUI rendering failed", error, info.componentStack); }
  render() { return this.state.error ? <ErrorView error={this.state.error} /> : this.props.children; }
}

root.render(<AgentGUIStartupShell loadingLabel="Loading Agent GUI" />);

try {
  const connection = await connectAgentGuiHost();
  document.documentElement.dataset.theme = connection.snapshot.theme;
  document.documentElement.classList.toggle("dark", connection.snapshot.theme === "dark");
  document.documentElement.lang = connection.snapshot.locale;
  const handle = createMulticaAgentGuiRuntime(connection.client, connection.snapshot);
  window.addEventListener("pagehide", () => { handle.dispose(); connection.dispose(); }, { once: true });
  await handle.initialize();
  root.render(<RenderedView><AgentGuiErrorBoundary><AgentGuiApplication client={connection.client} initial={connection.snapshot} handle={handle} /></AgentGuiErrorBoundary></RenderedView>);
} catch (error) {
  root.render(<RenderedView><ErrorView error={error instanceof Error ? error : new Error(String(error))} /></RenderedView>);
}
