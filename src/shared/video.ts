/**
 * 播放器观测 -> 平台任务状态的映射规则。
 *
 * 这是整个项目最需要被测试保护的地方（开发文档 §6.2、§13.1）：
 *
 *   「视频状态：播放器 ended 但平台状态 unknown 时，绝不显示已完成」
 *
 * 因此本模块**不做**任何自动提升。platformStatus 只能由平台接口返回，
 * 播放器观测永远不会写入它。mergeTaskWithObservation 是纯函数，可完整单测。
 */

import type { PlayerState, ProviderTaskState, VideoTask, PlaybackObservation } from './types'

/**
 * 计算「本地观测进度」百分比。
 * 播放器未报告时长时返回 null，而不是 0 或 100。
 */
export function observedProgressPercent(obs: PlaybackObservation | null): number | null {
  if (!obs) return null
  const { currentTimeSeconds, durationSeconds } = obs
  if (
    currentTimeSeconds === null ||
    durationSeconds === null ||
    !Number.isFinite(currentTimeSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null
  }
  const pct = (currentTimeSeconds / durationSeconds) * 100
  return Math.max(0, Math.min(100, pct))
}

/**
 * 判断是否满足「自动下一任务」的前置条件（开发文档 §6.2）。
 *
 * 必须同时满足：
 * 1. 用户已开启连续播放
 * 2. 真实观测到当前任务 ended（不是暂停、不是缓冲、不是错误）
 * 3. 观测来源可信（origin 必须是真实播放器，不能是 'unknown'）
 * 4. 没有待确认的交互（互动题 / 验证码 / 用户确认）
 */
export interface NextTaskDecisionInput {
  continuousEnabled: boolean
  observation: PlaybackObservation | null
  hasPendingInteraction: boolean
  platformAllowsNext: boolean
}

export interface NextTaskDecision {
  shouldAdvance: boolean
  reason:
    | 'ADVANCE'
    | 'CONTINUOUS_DISABLED'
    | 'NOT_ENDED'
    | 'NO_OBSERVATION'
    | 'UNTRUSTED_ORIGIN'
    | 'PENDING_INTERACTION'
    | 'PLATFORM_FORBIDDS'
}

export function decideNextTask(input: NextTaskDecisionInput): NextTaskDecision {
  if (!input.continuousEnabled) return { shouldAdvance: false, reason: 'CONTINUOUS_DISABLED' }
  if (input.hasPendingInteraction) return { shouldAdvance: false, reason: 'PENDING_INTERACTION' }
  if (!input.platformAllowsNext) return { shouldAdvance: false, reason: 'PLATFORM_FORBIDDS' }
  if (!input.observation) return { shouldAdvance: false, reason: 'NO_OBSERVATION' }
  if (input.observation.origin === 'unknown' || input.observation.origin === '') {
    return { shouldAdvance: false, reason: 'UNTRUSTED_ORIGIN' }
  }
  if (input.observation.playerState !== 'ended') {
    return { shouldAdvance: false, reason: 'NOT_ENDED' }
  }
  return { shouldAdvance: true, reason: 'ADVANCE' }
}

/**
 * 把观测合并到任务视图上。
 *
 * **关键不变量**：`platformStatus` 与 `platformStatusCheckedAt` 只接受平台侧数据，
 * 本函数永远保持传入 task 的原值不变。播放器 ended 不改变它。
 */
export function mergeTaskWithObservation(
  task: VideoTask,
  obs: PlaybackObservation | null
): VideoTask & { observation: PlaybackObservation | null; observedProgressPercent: number | null } {
  return {
    ...task,
    platformStatus: task.platformStatus,
    platformStatusCheckedAt: task.platformStatusCheckedAt,
    observation: obs,
    observedProgressPercent: observedProgressPercent(obs)
  }
}

/**
 * 生成展示用的双状态文案。刻意把两个状态分开呈现，
 * 避免用户把「播放器结束」误读成「平台已记完成」。
 */
export function describeTaskStatus(
  task: VideoTask,
  obs: PlaybackObservation | null
): { playerLabel: string; platformLabel: string; canShowCompleted: boolean } {
  const playerLabelMap: Record<PlayerState, string> = {
    unknown: '播放器未观测',
    playing: '播放中',
    paused: '已暂停',
    buffering: '缓冲中',
    ended: '播放器已结束',
    error: '播放异常'
  }
  const platformLabelMap: Record<ProviderTaskState, string> = {
    unknown: '平台状态未知',
    not_started: '平台：未开始',
    in_progress: '平台：进行中',
    completed: '平台：已确认完成'
  }
  const platformStatus = task.platformStatus
  return {
    playerLabel: obs ? playerLabelMap[obs.playerState] : '播放器未观测',
    platformLabel: platformLabelMap[platformStatus],
    // 只有平台明确返回 completed 才允许显示完成
    canShowCompleted: platformStatus === 'completed'
  }
}

/** 平台允许的倍速档位白名单。UI 只能用这个列表，不能让用户任意填。 */
export const ALLOWED_PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2] as const

export function isAllowedRate(rate: number): boolean {
  return (ALLOWED_PLAYBACK_RATES as readonly number[]).includes(rate)
}
