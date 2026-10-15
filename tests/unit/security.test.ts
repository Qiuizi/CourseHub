/**
 * 安全边界测试：origin 白名单、IPC 错误合同、日志脱敏。
 */

import { describe, it, expect } from 'vitest'
import { isOriginAllowed } from '@main/browser/platform-browser'
import { ok, fail, toErrorResult, isRetryable, CodedError } from '@shared/ipc'
import { Store } from '@main/services/store'

const ALLOWED = ['https://passport2.chaoxing.com', 'https://mobilelearn.chaoxing.com']

describe('origin 白名单', () => {
  it('允许精确匹配', () => {
    expect(isOriginAllowed('https://mobilelearn.chaoxing.com/v2/apis/x', ALLOWED)).toBe(true)
  })

  it('允许子域匹配', () => {
    expect(isOriginAllowed('https://a.mobilelearn.chaoxing.com/x', ALLOWED)).toBe(true)
  })

  it('拒绝其他域', () => {
    expect(isOriginAllowed('https://evil.com/x', ALLOWED)).toBe(false)
    expect(isOriginAllowed('https://chaoxing.com.evil.com/x', ALLOWED)).toBe(false)
  })

  it('拒绝后缀伪装', () => {
    // notmobilelearn.chaoxing.com 不应以 mobilelearn.chaoxing.com 结尾
    expect(isOriginAllowed('https://notmobilelearn.chaoxing.com/x', ALLOWED)).toBe(false)
    expect(isOriginAllowed('https://evilchaoxing.com/x', ALLOWED)).toBe(false)
  })

  it('拒绝任意协议', () => {
    for (const u of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'chrome://settings',
      'vbscript:msgbox'
    ]) {
      expect(isOriginAllowed(u, ALLOWED)).toBe(false)
    }
  })

  it('拒绝非法 URL', () => {
    expect(isOriginAllowed('not a url', ALLOWED)).toBe(false)
    expect(isOriginAllowed('', ALLOWED)).toBe(false)
  })
})

describe('IPC 响应合同', () => {
  it('ok 包装', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } })
  })

  it('fail 包装含 retryable', () => {
    const r = fail('UNSUPPORTED', 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
    }
  })

  it('可重试错误码', () => {
    expect(isRetryable('NETWORK_TIMEOUT')).toBe(true)
    expect(isRetryable('RATE_LIMITED')).toBe(true)
    expect(isRetryable('DATA_STALE')).toBe(true)
    expect(isRetryable('PLAYER_UNAVAILABLE')).toBe(false)
    expect(isRetryable('AI_KEY_INVALID')).toBe(false)
  })

  it('CodedError 被正确转换', () => {
    const r = toErrorResult(new CodedError('GEO_OVERRIDE_FAILED', 'boom'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('GEO_OVERRIDE_FAILED')
  })

  it('未知异常降级为 INVALID_REQUEST，不泄漏堆栈', () => {
    const r = toErrorResult(new Error('internal detail'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_REQUEST')
      expect(r.error.message).toBe('internal detail')
    }
  })

  it('非 Error 值也能处理', () => {
    const r = toErrorResult('plain string')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('plain string')
  })
})

describe('日志脱敏', () => {
  const store = new Store('C:/tmp/nonexistent-coursehub')

  it('屏蔽 apiKey 字段', () => {
    const out = store.redact({ apiKey: 'sk-secret', model: 'deepseek-flash' }) as Record<string, unknown>
    expect(out.apiKey).toBe('[REDACTED]')
    expect(out.model).toBe('deepseek-flash')
  })

  it('大小写不敏感地屏蔽敏感键', () => {
    const out = store.redact({ API_KEY: 'x', Authorization: 'y', Cookie: 'z', token: 't', password: 'p' }) as Record<string, unknown>
    for (const k of ['API_KEY', 'Authorization', 'Cookie', 'token', 'password']) {
      expect(out[k]).toBe('[REDACTED]')
    }
  })

  it('递归处理嵌套对象与数组', () => {
    const out = store.redact({ a: { b: { apiKey: 'secret' } }, list: [{ token: 't' }] }) as {
      a: { b: { apiKey: string } }
      list: { token: string }[]
    }
    expect(out.a.b.apiKey).toBe('[REDACTED]')
    expect(out.list[0]!.token).toBe('[REDACTED]')
  })

  it('超长字符串被截断', () => {
    const out = store.redact({ text: 'x'.repeat(1000) }) as Record<string, string>
    expect(out.text!.length).toBeLessThan(600)
    expect(out.text).toContain('[TRUNCATED]')
  })

  it('基础类型原样返回', () => {
    expect(store.redact(null)).toBeNull()
    expect(store.redact('str')).toBe('str')
    expect(store.redact(42)).toBe(42)
  })
})
