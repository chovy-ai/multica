import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../../../packages/views/locales/en/settings.json";

const mocks = vi.hoisted(() => ({ exportLogs: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "workspace", name: "Current workspace" }) }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user" } }) }));
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: (selector: (resources: typeof translations) => string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), selector(translations)) }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
import { LabsSettingsTab } from "./labs-settings-tab";

describe("Labs developer logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: { developerLogs: { export: mocks.exportLogs } } });
  });
  it("exports the selected workspace once, shows pending state and confirms the saved file", async () => {
    let finish!: (value: unknown) => void;
    mocks.exportLogs.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<LabsSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Export logs" }));
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
    expect(mocks.exportLogs).toHaveBeenCalledExactlyOnceWith({ userId: "user", workspaceId: "workspace" });
    finish({ status: "saved", filename: "logs.json", recordCount: 12 });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved logs.json · 12 records");
    expect(mocks.success).toHaveBeenCalledWith("Developer logs exported");
  });
  it("keeps cancellation silent and allows retry after a save failure", async () => {
    mocks.exportLogs.mockResolvedValueOnce({ status: "cancelled" }).mockRejectedValueOnce(new Error("private error"));
    render(<LabsSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Export logs" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export logs" })).toBeEnabled());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export logs" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Could not export logs. Try another save location."));
    expect(screen.getByRole("button", { name: "Export logs" })).toBeEnabled();
    expect(screen.queryByText("private error")).not.toBeInTheDocument();
  });
});
