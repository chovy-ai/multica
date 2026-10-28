// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { DesktopBrowserLogin } from "./browser-login";

const flows: DesktopBrowserLogin[] = [];
afterEach(() => {
  for (const flow of flows.splice(0)) flow.dispose();
  vi.useRealTimers();
});

function fixture() {
  const openBrowser = vi.fn().mockResolvedValue(undefined);
  const onToken = vi.fn();
  const flow = new DesktopBrowserLogin({ openBrowser, onToken });
  flows.push(flow);
  const callback = () => {
    const login = new URL(openBrowser.mock.calls.at(-1)![0]);
    const url = new URL(login.searchParams.get("cli_callback")!);
    url.searchParams.set("state", login.searchParams.get("cli_state")!);
    url.searchParams.set("token", "test-owned-bearer");
    return { login, url };
  };
  return { flow, openBrowser, onToken, callback };
}

describe("desktop browser login", () => {
  it("delivers the callback only to the initiating dev instance without opening Electron", async () => {
    const a = fixture(), b = fixture();
    await Promise.all([a.flow.start("https://multica.ai"), b.flow.start("https://multica.ai")]);
    const { login, url } = a.callback();
    expect(login.origin + login.pathname).toBe("https://multica.ai/login");
    expect(login.searchParams.get("platform")).toBe("desktop");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).not.toBe(b.callback().url.port);
    expect(login.searchParams.get("cli_state")).not.toBe(b.callback().login.searchParams.get("cli_state"));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("Multica");
    expect(html).not.toContain("test-owned-bearer");
    expect(a.onToken).toHaveBeenCalledExactlyOnceWith("test-owned-bearer");
    expect(b.onToken).not.toHaveBeenCalled();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("rejects wrong states, methods, paths, hosts and malformed tokens before delivering", async () => {
    const f = fixture();
    await f.flow.start("https://multica.ai");
    const { url } = f.callback();
    const wrong = new URL(url);
    wrong.searchParams.set("state", "different-attempt");
    expect((await fetch(wrong)).status).toBe(403);
    wrong.searchParams.set("state", "界".repeat(64));
    expect((await fetch(wrong)).status).toBe(403);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    const wrongPath = new URL(url); wrongPath.pathname = "/other";
    expect((await fetch(wrongPath)).status).toBe(404);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(url, { headers: { Host: "foreign.example" } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on("error", reject).end();
    });
    expect(foreignHostStatus).toBe(403);
    const missing = new URL(url); missing.searchParams.delete("token");
    expect((await fetch(missing)).status).toBe(400);
    const malformed = new URL(url); malformed.searchParams.set("token", "line\nbreak");
    expect((await fetch(malformed)).status).toBe(400);
    const repeated = new URL(url); repeated.searchParams.append("state", "duplicate");
    expect((await fetch(repeated)).status).toBe(403);
    expect(f.onToken).not.toHaveBeenCalled();
    expect((await fetch(url)).status).toBe(200);
    expect(f.onToken).toHaveBeenCalledOnce();
  });

  it("cancels the previous callback on retry and closes listeners on dispose", async () => {
    const f = fixture();
    await f.flow.start("https://multica.ai");
    const previous = f.callback().url;
    await f.flow.start("https://multica.ai");
    await expect(fetch(previous)).rejects.toThrow();
    const current = f.callback().url;
    f.flow.dispose();
    await expect(fetch(current)).rejects.toThrow();
    expect(f.onToken).not.toHaveBeenCalled();
  });

  it("releases an abandoned attempt after ten minutes", async () => {
    const f = fixture();
    await f.flow.start("https://multica.ai");
    const { url } = f.callback();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.flow.start("https://multica.ai");
    const abandoned = f.callback().url;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    vi.useRealTimers();
    await expect(fetch(url)).rejects.toThrow();
    await expect(fetch(abandoned)).rejects.toThrow();
    expect(f.onToken).not.toHaveBeenCalled();
  });

  it("closes the listener after browser-open failure and allows retry", async () => {
    const f = fixture();
    f.openBrowser.mockRejectedValueOnce(new Error("browser unavailable"));
    await expect(f.flow.start("https://multica.ai")).rejects.toThrow("browser unavailable");
    await expect(fetch(f.callback().url)).rejects.toThrow();
    await f.flow.start("https://multica.ai");
    expect((await fetch(f.callback().url)).status).toBe(200);
  });

  it("coalesces concurrent clicks and validates the configured web origin before listening", async () => {
    const f = fixture();
    await expect(f.flow.start("file:///tmp/foreign")).rejects.toThrow();
    expect(f.openBrowser).not.toHaveBeenCalled();
    await Promise.all([f.flow.start("https://multica.ai"), f.flow.start("https://multica.ai")]);
    expect(f.openBrowser).toHaveBeenCalledOnce();
  });
});
