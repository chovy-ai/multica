import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { LocalDeviceProvider, type LocalDevice } from "../platform/local-device";
import { WebResourcePreview } from "./local-resource-preview";

it("shows another device's local address as a notice instead of opening it here", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const request = vi.fn(async (_scope: unknown, _command: { action: string }) => null);
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { resourcePreview: { request, subscribe: () => () => {}, listChromeProfiles: vi.fn(async () => []) }, openExternal: vi.fn() } });
  const device = { id: "peer-1", name: "Mac Studio", transport: {} } as unknown as LocalDevice;
  render(<QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}>
    <WebResourcePreview id="web:1" url="http://localhost:3000/" scope={{ userId: "u", workspaceId: "w" }} active chinese onChange={() => {}} onReference={() => {}} />
  </LocalDeviceProvider></QueryClientProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("这是 Mac Studio 上的本地地址");
  expect(request.mock.calls.some(([, command]) => command.action === "show")).toBe(false);
  vi.unstubAllGlobals();
});
