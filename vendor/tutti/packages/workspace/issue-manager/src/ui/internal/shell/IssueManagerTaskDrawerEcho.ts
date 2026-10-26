const issueManagerTaskDrawerBackdropEchoMs = 900;
const issueManagerTaskDrawerBackdropEchoDistancePx = 72;

export interface IssueManagerPointerSnapshot {
  clientX: number;
  clientY: number;
  timeMs: number;
}

export function shouldIgnoreIssueManagerTaskDrawerBackdropEcho(input: {
  clickClientX: number;
  clickClientY: number;
  maxDistancePx?: number;
  maxElapsedMs?: number;
  nowMs: number;
  openPointer: IssueManagerPointerSnapshot | null;
}): {
  distancePx: number | null;
  elapsedMs: number | null;
  ignore: boolean;
} {
  if (!input.openPointer) {
    return {
      distancePx: null,
      elapsedMs: null,
      ignore: false
    };
  }

  const elapsedMs = input.nowMs - input.openPointer.timeMs;
  const distancePx = Math.hypot(
    input.clickClientX - input.openPointer.clientX,
    input.clickClientY - input.openPointer.clientY
  );
  return {
    distancePx,
    elapsedMs,
    ignore:
      elapsedMs <=
        (input.maxElapsedMs ?? issueManagerTaskDrawerBackdropEchoMs) &&
      distancePx <=
        (input.maxDistancePx ?? issueManagerTaskDrawerBackdropEchoDistancePx)
  };
}
