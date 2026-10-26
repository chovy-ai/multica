import { useDeferredValue, useEffect, useMemo } from "react";
import { useSnapshot } from "valtio";
import type {
  IssueManagerNodeState,
  IssueManagerOpenSource
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import { createIssueManagerControllerService } from "../../../../services/createIssueManagerControllerService.ts";
import type {
  IssueManagerControllerService,
  IssueManagerControllerSession
} from "../../../../services/issueManagerControllerService.interface.ts";
import {
  resolveIssueManagerFloatingNoticeViewState,
  type IssueManagerFloatingNoticeViewState
} from "../shell/IssueManagerNoticeState.ts";
import type { IssueManagerDiagnostics } from "../../../../internal/issueManagerDiagnostics.ts";

export function useIssueManagerControllerRuntime(input: {
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  openSource?: IssueManagerOpenSource;
  onStateChange?: (state: IssueManagerNodeState) => void;
  service?: IssueManagerControllerService;
  state?: Partial<IssueManagerNodeState> | null;
  workspaceId: string;
}): {
  controllerSession: IssueManagerControllerSession;
  deferredIssueSearch: string;
  floatingNotice: IssueManagerFloatingNoticeViewState | null;
  snapshot: IssueManagerControllerSession["store"];
} {
  const {
    diagnostics,
    feature,
    openSource,
    onStateChange,
    service,
    state,
    workspaceId
  } = input;
  const controllerService = useMemo(
    () => service ?? createIssueManagerControllerService(),
    [service]
  );
  const controllerSession = useMemo(
    () =>
      controllerService.createSession({
        diagnostics,
        feature,
        openSource,
        state,
        workspaceId
      }),
    [controllerService, diagnostics, feature, openSource, workspaceId]
  );
  const snapshot = useSnapshot(
    controllerSession.store
  ) as IssueManagerControllerSession["store"];
  const deferredIssueSearch = useDeferredValue(
    snapshot.nodeState.issueSearchQuery
  );
  const floatingNotice = resolveIssueManagerFloatingNoticeViewState({
    notification: snapshot.notification
  });

  useEffect(() => {
    controllerSession.retain();
    return () => {
      controllerSession.release();
    };
  }, [controllerSession]);

  useEffect(() => {
    controllerSession.syncInput({
      deferredIssueSearch,
      onStateChange,
      taskListCollapsed: state?.taskListCollapsed === true
    });
  }, [
    controllerSession,
    deferredIssueSearch,
    onStateChange,
    state?.taskListCollapsed
  ]);

  return {
    controllerSession,
    deferredIssueSearch,
    floatingNotice,
    snapshot
  };
}
