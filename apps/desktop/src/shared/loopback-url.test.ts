// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLoopbackUrl, previewLoopbackHost } from "./loopback-url";

describe("isLoopbackUrl", () => {
  it("recognizes addresses of the machine that opens them", () => {
    for (const url of ["http://localhost:3000", "http://app.localhost/", "http://127.0.0.1:8080/x", "http://127.1.2.3", "http://[::1]:5173", "http://0.0.0.0:4000"]) expect(isLoopbackUrl(url)).toBe(true);
    for (const url of ["https://example.com", "http://192.168.1.5:3000", "http://localhost.example.com", "not a url"]) expect(isLoopbackUrl(url)).toBe(false);
  });
});

it.each([
  ["http://localhost:3000", "localhost"], ["http://app.localhost.", "localhost"],
  ["http://127.1", "127.0.0.1"], ["http://2130706433", "127.0.0.1"], ["http://0x7f000001", "127.0.0.1"],
  ["http://0.0.0.0", "127.0.0.1"], ["http://[::1]", "::1"], ["http://[::ffff:127.0.0.1]", "127.0.0.1"],
  ["http://localhost.example.org", null], ["http://192.168.1.2", null], ["http://example.org", null], ["invalid", null],
])("normalizes loopback aliases without DNS: %s", (url, expected) => {
  expect(previewLoopbackHost(url!)).toBe(expected);
});
