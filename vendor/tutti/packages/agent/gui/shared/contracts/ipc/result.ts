import type { AppErrorDescriptor } from "../dto";

export interface IpcSuccessResult<T> {
  __tshIpcEnvelope: true;
  ok: true;
  value: T;
}

export interface IpcFailureResult {
  __tshIpcEnvelope: true;
  ok: false;
  error: AppErrorDescriptor;
}

export type IpcInvokeResult<T> = IpcSuccessResult<T> | IpcFailureResult;
