import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../../../packages/views/locales/en/settings.json";

const mocks = vi.hoisted(() => ({ servicePreview: vi.fn(), setServicePreview: vi.fn(), clearAgentServicePreviews: vi.fn() }));
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: (selector: (resources: typeof translations) => string) => selector(translations) }) }));
vi.mock("../platform/local-v2-transport", () => ({ localV2Transport: () => mocks }));
import { ServicePreviewSettings } from "./service-preview-settings";

const copy = translations.desktop.service_preview, dialog = translations.desktop.device_link;
const clients: QueryClient[] = [];
function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><ServicePreviewSettings /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.servicePreview.mockResolvedValue({ available: true, enabled: false, ports: [] });
  mocks.setServicePreview.mockImplementation(async (value) => ({ ...value, available: true }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });

it("keeps draft ports local until saving and confirming the independent sharing policy", async () => {
  renderSettings(); const toggle = await screen.findByRole("switch", { name: copy.allow });
  await waitFor(() => expect(toggle).not.toBeDisabled());
  fireEvent.click(toggle); fireEvent.change(screen.getByRole("textbox", { name: copy.ports }), { target: { value: "5173, 3000, 3000" } });
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: copy.save }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(copy.confirm_title);
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: dialog.cancel }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: copy.save }));
  fireEvent.click(await screen.findByRole("button", { name: dialog.confirm }));
  await waitFor(() => expect(mocks.setServicePreview).toHaveBeenCalledWith({ enabled: true, ports: [3000, 5173] }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
});

it.each(["0", "65536", "3000x", ""])("rejects an invalid enabled port list: %s", async (ports) => {
  renderSettings(); const toggle = await screen.findByRole("switch", { name: copy.allow });
  await waitFor(() => expect(toggle).not.toBeDisabled()); fireEvent.click(toggle);
  fireEvent.change(screen.getByRole("textbox", { name: copy.ports }), { target: { value: ports } });
  fireEvent.click(screen.getByRole("button", { name: copy.save }));
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.invalid_ports);
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
});

it("revokes sharing without a permission expansion dialog", async () => {
  mocks.servicePreview.mockResolvedValue({ available: true, enabled: true, ports: [3000] }); renderSettings();
  const toggle = await screen.findByRole("switch", { name: copy.allow }); await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: copy.save }));
  await waitFor(() => expect(mocks.setServicePreview).toHaveBeenCalledWith({ enabled: false, ports: [3000] }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("keeps saving unavailable when an old or offline daemon cannot read the policy", async () => {
  mocks.servicePreview.mockRejectedValue(new Error("old daemon")); renderSettings();
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.failed);
  expect(screen.getByRole("button", { name: copy.save })).toBeDisabled();
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
});

it("does not report success when the daemon returns malformed policy data", async () => {
  mocks.servicePreview.mockResolvedValue({ available: true, enabled: true, ports: [3000] });
  mocks.setServicePreview.mockResolvedValue({ enabled: "invalid" }); renderSettings();
  const toggle = await screen.findByRole("switch", { name: copy.allow }); await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: copy.save }));
  expect(await screen.findByRole("alert")).toHaveTextContent(copy.failed);
});

it("shows temporary Agent ports and revokes them without editing manual ports", async () => {
  mocks.servicePreview.mockResolvedValue({ available: true, enabled: true, ports: [8080], agent_ports: [3000, 5173] });
  mocks.clearAgentServicePreviews.mockResolvedValue({ available: true, enabled: true, ports: [8080], agent_ports: [] });
  renderSettings();
  expect(await screen.findByText("3000, 5173")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: copy.revoke_agent_ports }));
  await waitFor(() => expect(mocks.clearAgentServicePreviews).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByText("3000, 5173")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: copy.ports })).toHaveValue("8080");
  expect(mocks.setServicePreview).not.toHaveBeenCalled();
});
