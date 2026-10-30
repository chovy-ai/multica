// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isLoopbackUrl } from "./loopback-url";

describe("isLoopbackUrl", () => {
  it("recognizes addresses of the machine that opens them", () => {
    for (const url of ["http://localhost:3000", "http://app.localhost/", "http://127.0.0.1:8080/x", "http://127.1.2.3", "http://[::1]:5173", "http://0.0.0.0:4000"]) expect(isLoopbackUrl(url)).toBe(true);
    for (const url of ["https://example.com", "http://192.168.1.5:3000", "http://localhost.example.com", "not a url"]) expect(isLoopbackUrl(url)).toBe(false);
  });
});
