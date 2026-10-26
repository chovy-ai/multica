import { useEffect, useMemo } from "react";
import { useExternalStoreSnapshot } from "@tutti-os/ui-react-hooks";
import type { BrowserNodeFeature } from "../core/feature.ts";
import {
  acquireBrowserNodeController,
  type BrowserNodeControllerState
} from "../core/nodeController.ts";
import type {
  BrowserNodeNavigationPolicy,
  BrowserNodeSessionMode
} from "../core/types.ts";

export function useBrowserNodeController(input: {
  defaultUrl: string;
  feature: BrowserNodeFeature;
  navigationPolicy?: BrowserNodeNavigationPolicy | null;
  nodeId: string;
  profileId?: string | null;
  sessionMode?: BrowserNodeSessionMode;
  sessionPartition?: string | null;
  syncDefaultUrl?: boolean;
}) {
  const controller = useMemo(
    () =>
      acquireBrowserNodeController({
        defaultUrl: input.defaultUrl,
        feature: input.feature,
        navigationPolicy: input.navigationPolicy,
        nodeId: input.nodeId,
        profileId: input.profileId ?? null,
        sessionMode: input.sessionMode ?? "shared",
        sessionPartition: input.sessionPartition,
        syncDefaultUrl: input.syncDefaultUrl ?? false
      }),
    [
      input.defaultUrl,
      input.feature,
      input.navigationPolicy,
      input.nodeId,
      input.profileId,
      input.sessionMode,
      input.sessionPartition,
      input.syncDefaultUrl
    ]
  );

  useEffect(() => {
    controller.retain();
    return () => {
      controller.release();
    };
  }, [controller]);

  useEffect(() => {
    controller.sync();
  }, [
    controller,
    input.defaultUrl,
    input.feature,
    input.navigationPolicy,
    input.nodeId,
    input.profileId,
    input.sessionMode,
    input.sessionPartition,
    input.syncDefaultUrl
  ]);
  const state = useExternalStoreSnapshot<BrowserNodeControllerState>({
    getSnapshot() {
      return controller.getState();
    },
    subscribe(listener) {
      return controller.subscribe(listener);
    }
  });

  return {
    controller,
    state
  };
}
