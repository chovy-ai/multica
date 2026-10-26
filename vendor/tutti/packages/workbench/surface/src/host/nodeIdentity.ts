export interface WorkbenchHostNodeIdentityInput {
  instanceId: string;
  typeId: string;
}

export function createWorkbenchHostProjectedNodeId(
  input: WorkbenchHostNodeIdentityInput
): string {
  return `${input.typeId}:${input.instanceId}`;
}

export function createWorkbenchHostLaunchedNodeId(
  input: WorkbenchHostNodeIdentityInput
): string {
  return input.instanceId === input.typeId
    ? input.typeId
    : createWorkbenchHostProjectedNodeId(input);
}
