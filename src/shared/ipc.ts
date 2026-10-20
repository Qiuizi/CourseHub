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

/**
 * 判断一个对象是否已经符合 IpcResult 合同。
 * 严格校验：
 * - ok 为 true 时必须包含 data 属性
 * - ok 为 false 时必须包含具备 code 与 message 的 error 对象
 * 避免二次包裹产生 { ok: true, data: { ok: true, data: ... } }
 */
export function isIpcResult<T = unknown>(val: unknown): val is IpcResult<T> {
  if (!val || typeof val !== 'object') return false
  const obj = val as Record<string, unknown>
  if (typeof obj.ok !== 'boolean') return false
  if (obj.ok === true) {
    return 'data' in obj
  }
  if (obj.ok === false) {
    return (
      typeof obj.error === 'object' &&
      obj.error !== null &&
      'code' in obj.error &&
      'message' in obj.error
    )
  }
  return false
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
