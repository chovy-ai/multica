import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDeviceProvider, type LocalDevice } from "../platform/local-device";
import { WebResourcePreview } from "./local-resource-preview";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("requires a source conversation before opening another device's local address", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const request = vi.fn(async (_scope: unknown, _command: { action: string }) => null);
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { resourcePreview: { request, subscribe: () => () => {}, listChromeProfiles: vi.fn(async () => []) }, openExternal: vi.fn() } });
  const device = { id: "peer-1", name: "Mac Studio", transport: {} } as unknown as LocalDevice;
  render(<QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}>
    <WebResourcePreview id="web:1" url="http://localhost:3000/" scope={{ userId: "u", workspaceId: "w" }} active chinese onChange={() => {}} onReference={() => {}} />
  </LocalDeviceProvider></QueryClientProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("请先选择来源会话");
  expect(request.mock.calls.some(([, command]) => command.action === "show")).toBe(false);
  vi.unstubAllGlobals();
});

it("carries the remote device and conversation into the native preview and blocks external localhost navigation", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const request = vi.fn(async () => null);
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { resourcePreview: { request, subscribe: () => () => {}, listChromeProfiles: vi.fn(async () => []) }, openExternal: vi.fn() } });
  const device = { id: "peer-1", name: "Mac Studio", transport: {} } as unknown as LocalDevice;
  render(<QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}><WebResourcePreview id="web:2" url="http://localhost:3000/" conversationId="conversation" scope={{ userId: "u", workspaceId: "w" }} active chinese onChange={() => {}} onReference={() => {}} /></LocalDeviceProvider></QueryClientProvider>);
  await waitFor(() => expect(request).toHaveBeenCalledWith({ userId: "u", workspaceId: "w" }, expect.objectContaining({ action: "show", url: "http://localhost:3000/", target: { deviceId: "peer-1", conversationId: "conversation" } })));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: "在浏览器中打开" })) expect(button).toBeDisabled();
  vi.unstubAllGlobals();
});
