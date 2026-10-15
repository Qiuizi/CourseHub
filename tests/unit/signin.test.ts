/**
 * 签到状态归一化与去重测试。
 *
 * 核心不变量：本地记忆永远不能把状态升级为「已签到」。
 */

import { describe, it, expect } from 'vitest'
import {
  signInDedupeKey,
  isEventOnDay,
  normalizeSignInKind,
  resolveSignInStatus,
  mergeSignInEvents,
  isStale
} from '@shared/signin'
import type { SignInEvent } from '@shared/types'

function makeEvent(over: Partial<SignInEvent> = {}): SignInEvent {
  return {
    id: 'a1',
    platformId: 'chaoxing',
    courseId: 'c1',
    kind: 'normal',
    title: '第 3 讲签到',
    startAt: '2026-10-15T01:00:00.000Z',
    endAt: '2026-10-15T02:00:00.000Z',
    sourceUrl: 'https://mobilelearn.chaoxing.com/x',
    fetchedAt: '2026-10-15T00:30:00.000Z',
    status: 'open',
    statusSource: 'none',
    locationText: null,
    locationRequired: false,
    ...over
  }
}

describe('去重键', () => {
  it('同一活动跨轮询得到相同键', () => {
    expect(signInDedupeKey({ platformId: 'chaoxing', id: 'a1' })).toBe(
      signInDedupeKey({ platformId: 'chaoxing', id: 'a1' })
    )
  })

  it('不同平台的相同 id 不碰撞', () => {
    expect(signInDedupeKey({ platformId: 'chaoxing', id: 'a1' })).not.toBe(
      signInDedupeKey({ platformId: 'yuketang', id: 'a1' })
    )
  })
})

describe('isEventOnDay 时区处理', () => {
  it('按来源时区判定当天', () => {
    // UTC 2026-10-14T17:00 在 Asia/Shanghai 是 10-15
    expect(isEventOnDay('2026-10-15', '2026-10-14T17:00:00.000Z', 'Asia/Shanghai')).toBe(true)
    expect(isEventOnDay('2026-10-14', '2026-10-14T17:00:00.000Z', 'Asia/Shanghai')).toBe(false)
  })

  it('无时区信息时退回 UTC 比较，不臆断', () => {
    expect(isEventOnDay('2026-10-15', '2026-10-15T01:00:00.000Z', null)).toBe(true)
  })

  it('无事件时间返回 false', () => {
    expect(isEventOnDay('2026-10-15', null, 'Asia/Shanghai')).toBe(false)
  })

  it('非法时区返回 null 表示无法判定', () => {
    expect(isEventOnDay('2026-10-15', '2026-10-15T01:00:00.000Z', 'Not/AZone')).toBeNull()
  })
})

describe('normalizeSignInKind', () => {
  it('映射已知取值', () => {
    expect(normalizeSignInKind(0)).toBe('normal')
    expect(normalizeSignInKind(2)).toBe('normal')
    expect(normalizeSignInKind(74)).toBe('normal')
  })

  it('未知取值返回 unknown 而非猜测', () => {
    expect(normalizeSignInKind(999)).toBe('unknown')
    expect(normalizeSignInKind(null)).toBe('unknown')
    expect(normalizeSignInKind('abc')).toBe('unknown')
    expect(normalizeSignInKind(undefined)).toBe('unknown')
  })
})

describe('resolveSignInStatus 本地记忆不得升级状态', () => {
  const now = '2026-10-15T01:30:00.000Z'

  it('平台本次明确确认才可 checked_in', () => {
    const r = resolveSignInStatus({
      rawStatus: 1,
      locallyRemembered: false,
      hasProviderEvidence: true,
      nowISO: now,
      startAt: '2026-10-15T01:00:00.000Z',
      endAt: '2026-10-15T02:00:00.000Z'
    })
    expect(r.status).toBe('checked_in')
    expect(r.source).toBe('provider_api')
  })

  it('仅有本地记忆时绝不能是 checked_in', () => {
    const r = resolveSignInStatus({
      rawStatus: 1,
      locallyRemembered: true,
      hasProviderEvidence: false,
      nowISO: now,
      startAt: '2026-10-15T01:00:00.000Z',
      endAt: '2026-10-15T02:00:00.000Z'
    })
    expect(r.status).not.toBe('checked_in')
    expect(r.status).toBe('open')
    expect(r.source).toBe('local_dedupe')
  })

  it('未开始返回 pending', () => {
    const r = resolveSignInStatus({
      rawStatus: null,
      locallyRemembered: false,
      hasProviderEvidence: false,
      nowISO: now,
      startAt: '2026-10-15T03:00:00.000Z',
      endAt: '2026-10-15T04:00:00.000Z'
    })
    expect(r.status).toBe('pending')
  })

  it('已过截止时间返回 closed', () => {
    const r = resolveSignInStatus({
      rawStatus: null,
      locallyRemembered: false,
      hasProviderEvidence: false,
      nowISO: now,
      startAt: '2026-10-15T00:00:00.000Z',
      endAt: '2026-10-15T01:00:00.000Z'
    })
    expect(r.status).toBe('closed')
  })

  it('无任何依据时返回 open + none，不编造状态', () => {
    const r = resolveSignInStatus({
      rawStatus: null,
      locallyRemembered: false,
      hasProviderEvidence: false,
      nowISO: now,
      startAt: null,
      endAt: null
    })
    expect(r.status).toBe('open')
    expect(r.source).toBe('none')
  })
})

describe('mergeSignInEvents 跨轮询合并', () => {
  it('相同 key 不重复累积', () => {
    const prev = [makeEvent()]
    const next = [makeEvent({ fetchedAt: '2026-10-15T00:40:00.000Z' })]
    expect(mergeSignInEvents(prev, next)).toHaveLength(1)
  })

  it('平台证据优先于本地推断', () => {
    const prev = [makeEvent({ status: 'open', statusSource: 'local_dedupe' })]
    const next = [makeEvent({ status: 'checked_in', statusSource: 'provider_api' })]
    const merged = mergeSignInEvents(prev, next)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.status).toBe('checked_in')
    expect(merged[0]!.statusSource).toBe('provider_api')
  })

  it('平台证据不被后续的本地推断覆盖', () => {
    const prev = [makeEvent({ status: 'checked_in', statusSource: 'provider_api' })]
    const next = [makeEvent({ status: 'open', statusSource: 'local_dedupe' })]
    const merged = mergeSignInEvents(prev, next)
    expect(merged[0]!.status).toBe('checked_in')
  })

  it('不同活动都能保留', () => {
    const prev = [makeEvent({ id: 'a1' })]
    const next = [makeEvent({ id: 'a2' })]
    expect(mergeSignInEvents(prev, next)).toHaveLength(2)
  })

  it('不同平台的相同 id 不被合并', () => {
    const prev = [makeEvent({ id: 'a1', platformId: 'chaoxing' })]
    const next = [makeEvent({ id: 'a1', platformId: 'yuketang' })]
    expect(mergeSignInEvents(prev, next)).toHaveLength(2)
  })
})

describe('数据新鲜度', () => {
  it('超过阈值标记 stale', () => {
    expect(isStale('2026-10-15T00:00:00.000Z', '2026-10-15T02:00:00.000Z', 3_600_000)).toBe(true)
  })

  it('阈值内不算 stale', () => {
    expect(isStale('2026-10-15T01:50:00.000Z', '2026-10-15T02:00:00.000Z', 3_600_000)).toBe(false)
  })

  it('时间非法时视为 stale', () => {
    expect(isStale('not-a-date', '2026-10-15T02:00:00.000Z', 3_600_000)).toBe(true)
  })
})
