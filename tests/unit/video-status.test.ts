/**
 * 视频双状态不变量的回归测试。
 *
 * 这是整个项目最关键的安全性质：
 * 「播放器 ended 但平台状态 unknown 时，绝不显示已完成」。
 * 任何重构若破坏这些用例，必须被视为破坏性变更。
 */

import { describe, it, expect } from 'vitest'
import {
  observedProgressPercent,
  decideNextTask,
  mergeTaskWithObservation,
  describeTaskStatus,
  isAllowedRate,
  ALLOWED_PLAYBACK_RATES
} from '@shared/video'
import type { VideoTask, PlaybackObservation, PlayerState, ProviderTaskState } from '@shared/types'

function makeTask(over: Partial<VideoTask> = {}): VideoTask {
  return {
    id: 'chaoxing:t1',
    platformId: 'chaoxing',
    courseId: 'c1',
    sectionId: null,
    title: '任务 1',
    sourceUrl: 'https://mobilelearn.chaoxing.com/task',
    order: 1,
    durationSeconds: 600,
    fetchedAt: '2026-10-15T00:00:00.000Z',
    platformStatus: 'unknown',
    platformStatusCheckedAt: null,
    supportedControls: ['play', 'pause', 'volume', 'rate'],
    ...over
  }
}

function makeObs(over: Partial<PlaybackObservation> = {}): PlaybackObservation {
  return {
    taskId: 'chaoxing:t1',
    playerState: 'playing',
    currentTimeSeconds: 100,
    durationSeconds: 600,
    playbackRate: 1,
    volume: 1,
    muted: false,
    observedAt: '2026-10-15T00:01:00.000Z',
    origin: 'html5-video',
    ...over
  }
}

describe('observedProgressPercent', () => {
  it('正常计算百分比', () => {
    expect(observedProgressPercent(makeObs({ currentTimeSeconds: 300, durationSeconds: 600 }))).toBe(50)
  })

  it('时长未知时返回 null，不用 0 冒充', () => {
    expect(observedProgressPercent(makeObs({ durationSeconds: null }))).toBeNull()
  })

  it('无观测时返回 null', () => {
    expect(observedProgressPercent(null)).toBeNull()
  })

  it('时长为 0 或负数时返回 null', () => {
    expect(observedProgressPercent(makeObs({ durationSeconds: 0 }))).toBeNull()
    expect(observedProgressPercent(makeObs({ durationSeconds: -5 }))).toBeNull()
  })

  it('超出范围时夹紧到 [0,100]', () => {
    expect(observedProgressPercent(makeObs({ currentTimeSeconds: 9999, durationSeconds: 600 }))).toBe(100)
    expect(observedProgressPercent(makeObs({ currentTimeSeconds: -10, durationSeconds: 600 }))).toBe(0)
  })

  it('NaN / Infinity 返回 null', () => {
    expect(observedProgressPercent(makeObs({ currentTimeSeconds: NaN }))).toBeNull()
    expect(observedProgressPercent(makeObs({ durationSeconds: Infinity }))).toBeNull()
  })
})

describe('平台状态绝不被播放器观测提升', () => {
  it('播放器 ended 但平台 unknown 时，不显示完成', () => {
    const task = makeTask({ platformStatus: 'unknown' })
    const obs = makeObs({ playerState: 'ended', currentTimeSeconds: 600 })
    const merged = mergeTaskWithObservation(task, obs)

    // 关键断言
    expect(merged.platformStatus).toBe('unknown')
    expect(merged.platformStatusCheckedAt).toBeNull()

    const desc = describeTaskStatus(merged, obs)
    expect(desc.playerLabel).toBe('播放器已结束')
    expect(desc.platformLabel).toBe('平台状态未知')
    expect(desc.canShowCompleted).toBe(false)
  })

  it('播放器 ended 也不改写 platformStatusCheckedAt', () => {
    const task = makeTask({ platformStatus: 'unknown', platformStatusCheckedAt: null })
    for (const state of ['playing', 'paused', 'buffering', 'ended', 'error'] as PlayerState[]) {
      const merged = mergeTaskWithObservation(task, makeObs({ playerState: state }))
      expect(merged.platformStatus).toBe('unknown')
      expect(merged.platformStatusCheckedAt).toBeNull()
    }
  })

  it('仅当平台明确返回 completed 才允许显示完成', () => {
    const task = makeTask({
      platformStatus: 'completed',
      platformStatusCheckedAt: '2026-10-15T00:02:00.000Z'
    })
    const merged = mergeTaskWithObservation(task, makeObs({ playerState: 'ended' }))
    const desc = describeTaskStatus(merged, makeObs({ playerState: 'ended' }))
    expect(desc.canShowCompleted).toBe(true)
    expect(desc.platformLabel).toBe('平台：已确认完成')
  })

  it('平台未确认但播放器正常播放时也不显示完成', () => {
    const task = makeTask({ platformStatus: 'in_progress' })
    const obs = makeObs({ playerState: 'playing' })
    expect(describeTaskStatus(task, obs).canShowCompleted).toBe(false)
  })
})

describe('decideNextTask 连续播放门禁', () => {
  const base = {
    continuousEnabled: true,
    observation: makeObs({ playerState: 'ended' }),
    hasPendingInteraction: false,
    platformAllowsNext: true
  }

  it('全部条件满足时允许下一个任务', () => {
    expect(decideNextTask(base)).toEqual({ shouldAdvance: true, reason: 'ADVANCE' })
  })

  it('未开启连续播放则不推进', () => {
    const r = decideNextTask({ ...base, continuousEnabled: false })
    expect(r.shouldAdvance).toBe(false)
    expect(r.reason).toBe('CONTINUOUS_DISABLED')
  })

  it('有互动题/验证码待确认时立即停止', () => {
    const r = decideNextTask({ ...base, hasPendingInteraction: true })
    expect(r.shouldAdvance).toBe(false)
    expect(r.reason).toBe('PENDING_INTERACTION')
  })

  it('播放器未 ended 不推进（暂停/缓冲/异常都不行）', () => {
    for (const state of ['playing', 'paused', 'buffering', 'error', 'unknown'] as PlayerState[]) {
      const r = decideNextTask({ ...base, observation: makeObs({ playerState: state }) })
      expect(r.shouldAdvance).toBe(false)
      expect(r.reason).toBe('NOT_ENDED')
    }
  })

  it('无可观测数据时不推进', () => {
    const r = decideNextTask({ ...base, observation: null })
    expect(r.shouldAdvance).toBe(false)
    expect(r.reason).toBe('NO_OBSERVATION')
  })

  it('观测来源不可信时不推进', () => {
    const r = decideNextTask({ ...base, observation: makeObs({ origin: 'unknown' }) })
    expect(r.shouldAdvance).toBe(false)
    expect(r.reason).toBe('UNTRUSTED_ORIGIN')
  })

  it('平台不允许跳转时不推进', () => {
    const r = decideNextTask({ ...base, platformAllowsNext: false })
    expect(r.shouldAdvance).toBe(false)
    expect(r.reason).toBe('PLATFORM_FORBIDDS')
  })
})

describe('倍速白名单', () => {
  it('仅允许白名单内倍速', () => {
    for (const r of ALLOWED_PLAYBACK_RATES) expect(isAllowedRate(r)).toBe(true)
  })

  it('拒绝任意倍速', () => {
    for (const r of [0.5, 1.1, 3, 8, 16, -1, 0]) expect(isAllowedRate(r)).toBe(false)
  })
})

describe('ProviderTaskState 覆盖完整性', () => {
  it('四种平台状态都有对应文案', () => {
    const states: ProviderTaskState[] = ['unknown', 'not_started', 'in_progress', 'completed']
    for (const s of states) {
      const d = describeTaskStatus(makeTask({ platformStatus: s }), null)
      expect(d.platformLabel.length).toBeGreaterThan(0)
      expect(d.canShowCompleted).toBe(s === 'completed')
    }
  })
})
