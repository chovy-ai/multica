export function isWorkspaceAgentSyntheticControlMessage(
  text: string | undefined | null
): boolean {
  const normalized = text?.trim().toLowerCase() ?? "";
  switch (normalized) {
    case "[request interrupted by user]":
    case "request interrupted by user":
    case "[request interrupted by user for tool use]":
    case "request interrupted by user for tool use":
      return true;
    default:
      return false;
  }
}
