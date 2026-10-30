import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../../../packages/views/locales/en/settings.json";

const mocks = vi.hoisted(() => ({ deviceLink: vi.fn(), setDeviceLink: vi.fn() }));
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: (selector: (resources: typeof translations) => string) => selector(translations) }) }));
vi.mock("../platform/local-v2-transport", () => ({ localV2Transport: () => ({ deviceLink: mocks.deviceLink, setDeviceLink: mocks.setDeviceLink }) }));
import { DeviceLinkSettingsTab } from "./device-link-settings-tab";

const copy = translations.desktop.device_link;
const renderTab = () => render(<QueryClientProvider client={new QueryClient()}><DeviceLinkSettingsTab /></QueryClientProvider>);

describe("Device link settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deviceLink.mockResolvedValue({ available: true, enabled: false });
  });

  it("asks before letting other devices in and stays off until the daemon accepts", async () => {
    let finish!: (value: unknown) => void;
    mocks.setDeviceLink.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderTab();
    const toggle = await screen.findByRole("switch", { name: copy.allow });
    await waitFor(() => expect(toggle).not.toHaveAttribute("data-disabled"));
    fireEvent.click(toggle);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(copy.confirm_title);
    expect(mocks.setDeviceLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.confirm }));
    await waitFor(() => expect(mocks.setDeviceLink).toHaveBeenCalledWith(true));
    // The modal hides the page from assistive technology meanwhile.
    expect(screen.getByRole("switch", { name: copy.allow, hidden: true })).not.toBeChecked();
    finish({ available: true, enabled: true });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: copy.allow })).toBeChecked();
  });

  it("keeps the dialog open with an error when turning on fails", async () => {
    mocks.setDeviceLink.mockRejectedValueOnce(new Error("disk full"));
    renderTab();
    const toggle = await screen.findByRole("switch", { name: copy.allow });
    await waitFor(() => expect(toggle).not.toHaveAttribute("data-disabled"));
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: copy.confirm }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.save_failed);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("turns off without confirmation", async () => {
    mocks.deviceLink.mockResolvedValue({ available: true, enabled: true });
    mocks.setDeviceLink.mockResolvedValue({ available: true, enabled: false });
    renderTab();
    const toggle = await screen.findByRole("switch", { name: copy.allow });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setDeviceLink).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: copy.allow })).not.toBeChecked());
  });
});
