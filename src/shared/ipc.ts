/**
 * IPC 响应合同与错误码映射。
 * 所有 IPC 统一 {ok:true,data} | {ok:false,error:{code,message,retryable}}（开发文档 §10）。
 */

import type { IpcResult, ErrorCode } from './types'

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail<T = never>(
  code: ErrorCode,
  message: string,
  retryable = false
): IpcResult<T> {
  return { ok: false, error: { code, message, retryable } }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK_TIMEOUT',
  'RATE_LIMITED',
  'DATA_STALE'
])

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

/** 把任意异常转成受控错误，避免把堆栈泄漏到 renderer。 */
export function toErrorResult(err: unknown): IpcResult<never> {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: ErrorCode }).code
    if (typeof code === 'string') {
      const message =
        err instanceof Error ? err.message : 'unknown error'
      return fail(code, message, isRetryable(code))
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return fail('INVALID_REQUEST', message, false)
}

/** 带错误码的异常，供主进程内部抛出后被 toErrorResult 捕获。 */
export class CodedError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'CodedError'
    this.code = code
  }
}
