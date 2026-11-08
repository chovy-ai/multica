// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => keychain.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    keychain.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    keychain.delete(key);
  }),
}));

import { adoptVerificationLogin } from "./verification-login";

const globals = globalThis as { __DEV__?: boolean };
beforeEach(() => {
  keychain.clear();
  globals.__DEV__ = true;
  vi.stubEnv("EXPO_PUBLIC_VERIFICATION_TOKEN", "test-token");
  vi.stubEnv("EXPO_PUBLIC_VERIFICATION_WORKSPACE_SLUG", "verification");
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete globals.__DEV__;
});

it("signs a fresh Debug install into the verification account and workspace", async () => {
  await adoptVerificationLogin();
  expect(keychain.get("multica_token")).toBe("test-token");
  expect(keychain.get("multica_current_workspace_slug")).toBe("verification");
});

it("keeps a credential that is already stored", async () => {
  keychain.set("multica_token", "own-token");
  await adoptVerificationLogin();
  expect(keychain.get("multica_token")).toBe("own-token");
  expect(keychain.has("multica_current_workspace_slug")).toBe(false);
});

it("does nothing in Release bundles or without a host-issued token", async () => {
  globals.__DEV__ = false;
  await adoptVerificationLogin();
  globals.__DEV__ = true;
  vi.stubEnv("EXPO_PUBLIC_VERIFICATION_TOKEN", "");
  await adoptVerificationLogin();
  expect(keychain.size).toBe(0);
});
