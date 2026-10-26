export interface IssueManagerDiagnostics {
  log(
    event: string,
    details: Record<string, unknown>,
    options?: { includeStack?: boolean }
  ): void;
}

export function logIssueManagerDiagnostic(
  diagnostics: IssueManagerDiagnostics | null | undefined,
  event: string,
  details: Record<string, unknown> = {},
  options: { includeStack?: boolean } = {}
): void {
  diagnostics?.log(
    event,
    {
      ...details,
      ...(options.includeStack ? { stack: new Error().stack } : {})
    },
    options
  );
}
