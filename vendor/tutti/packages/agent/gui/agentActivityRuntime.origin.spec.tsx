import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentGUIRuntimeProvider,
  resetAgentGUIRuntimeForTests,
  useAgentGUIRuntime,
  type AgentGUIRuntime
} from "./agentActivityRuntime";

function createRuntime(origin: string): AgentGUIRuntime {
  return { origin } as unknown as AgentGUIRuntime;
}

function RuntimeIdentity({ testId }: { testId: string }) {
  const runtime = useAgentGUIRuntime();
  return <div data-testid={testId}>{runtime.origin}</div>;
}

afterEach(() => {
  cleanup();
  resetAgentGUIRuntimeForTests();
});

describe("AgentGUIRuntimeProvider identity isolation", () => {
  it("resolves coexisting runtimes only from the nearest provider", () => {
    render(
      <>
        <AgentGUIRuntimeProvider runtime={createRuntime("origin-local")}>
          <RuntimeIdentity testId="local-runtime" />
        </AgentGUIRuntimeProvider>
        <AgentGUIRuntimeProvider runtime={createRuntime("origin-shared")}>
          <RuntimeIdentity testId="shared-runtime" />
        </AgentGUIRuntimeProvider>
      </>
    );

    expect(screen.getByTestId("local-runtime")).toHaveTextContent(
      "origin-local"
    );
    expect(screen.getByTestId("shared-runtime")).toHaveTextContent(
      "origin-shared"
    );
  });

  it("does not let a later sibling provider replace an existing consumer", () => {
    const view = render(
      <AgentGUIRuntimeProvider runtime={createRuntime("origin-local")}>
        <RuntimeIdentity testId="local-runtime" />
      </AgentGUIRuntimeProvider>
    );

    view.rerender(
      <>
        <AgentGUIRuntimeProvider runtime={createRuntime("origin-local")}>
          <RuntimeIdentity testId="local-runtime" />
        </AgentGUIRuntimeProvider>
        <AgentGUIRuntimeProvider runtime={createRuntime("origin-shared")}>
          <RuntimeIdentity testId="shared-runtime" />
        </AgentGUIRuntimeProvider>
      </>
    );

    expect(screen.getByTestId("local-runtime")).toHaveTextContent(
      "origin-local"
    );
  });
});
