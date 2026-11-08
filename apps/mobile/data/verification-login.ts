import * as SecureStore from "expo-secure-store";

import { getToken, setToken } from "./secure-storage";
import { WORKSPACE_SLUG_KEY } from "./workspace-store";

/**
 * Signs a fresh simulator into the verification host's local test backend.
 *
 * The host (packages/verification) issues the test account's token and serves
 * this Debug bundle from its own Metro with the token inlined, mirroring the
 * desktop verification /login handoff. Release bundles have __DEV__ false and
 * never carry these variables. A credential already in the Keychain wins.
 */
export async function adoptVerificationLogin(): Promise<void> {
  if (!__DEV__) return;
  const token = process.env.EXPO_PUBLIC_VERIFICATION_TOKEN;
  if (!token || (await getToken())) return;
  await setToken(token);
  const slug = process.env.EXPO_PUBLIC_VERIFICATION_WORKSPACE_SLUG;
  if (slug) await SecureStore.setItemAsync(WORKSPACE_SLUG_KEY, slug);
}
