import {
  setCollaborationRunAdoption as setCollaborationRunAdoptionRequest,
  type CollaborationRun,
  type SetCollaborationRunAdoptionRequest
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidRequestOptions } from "./tuttidClientTypes.ts";

export interface CollaborationRunsClient {
  setCollaborationRunAdoption(
    workspaceID: string,
    collaborationRunID: string,
    request: SetCollaborationRunAdoptionRequest,
    requestOptions?: TuttidRequestOptions
  ): Promise<CollaborationRun>;
}

export function createCollaborationRunsClient(
  client: Client
): CollaborationRunsClient {
  return {
    async setCollaborationRunAdoption(
      workspaceID,
      collaborationRunID,
      request,
      requestOptions
    ) {
      return unwrapData(
        await setCollaborationRunAdoptionRequest({
          client,
          body: request,
          path: { collaborationRunID, workspaceID },
          ...requestOptions
        }),
        "Collaboration adoption request failed."
      );
    }
  };
}
