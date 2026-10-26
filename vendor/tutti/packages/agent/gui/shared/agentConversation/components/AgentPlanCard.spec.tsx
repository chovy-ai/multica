import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentPlanCard } from "./AgentPlanCard";

describe("AgentPlanCard", () => {
  it("starts collapsed and expands on demand", () => {
    const { getByTestId, queryByTestId } = render(
      <AgentPlanCard copyText="# Plan">
        <div>plan body</div>
      </AgentPlanCard>
    );

    const card = getByTestId("agent-plan-card");
    expect(card.getAttribute("data-collapsed")).toBe("true");
    expect(getByTestId("agent-plan-card-expand")).toBeTruthy();

    fireEvent.click(getByTestId("agent-plan-card-expand"));
    expect(card.getAttribute("data-collapsed")).toBe("false");
    expect(queryByTestId("agent-plan-card-expand")).toBeNull();
  });

  it("copies the plan markdown to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { getByTestId } = render(
      <AgentPlanCard copyText="plan-copy-text">
        <div>plan body</div>
      </AgentPlanCard>
    );

    fireEvent.click(getByTestId("agent-plan-card-copy"));
    expect(writeText).toHaveBeenCalledWith("plan-copy-text");
  });
});
