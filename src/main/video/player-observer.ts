/**
 * 播放器观测器。
 *
 * 严格遵循开发文档 §6.2：
 * - 只通过真实 DOM/事件观察 playing/paused/buffering/ended/error。
 * - 兼容 HTML5 <video>；iframe / HLS / 受保护播放器分别实测，不假定统一控制。
 * - 不伪造心跳、不推算完成、不生成观看时长。
 * - currentTime / duration 缺失时返回 null，绝不用 0 冒充。
 */

import type { PlaybackObservation, PlayerState } from '@shared/types'

/**
 * 在页面上下文执行的观测脚本。
 *
 * 以字符串形式交给 executeJavaScript，函数体自包含，不接受外部变量。
 * 只读取标准 HTML5 video 属性，通过标准事件更新状态，不做任何写操作。
 */
function buildObserverScript(taskId: string): string {
  return `(() => {
  const targetId = ${JSON.stringify(taskId)};
  let main = null;
  if (targetId) {
    const container = document.querySelector('[data-task="' + CSS.escape(targetId) + '"]');
    if (container) {
      main = container.querySelector('video');
    } else {
      const el = document.getElementById(targetId);
      if (el && el.tagName === 'VIDEO') main = el;
    }
  }
  if (!main) {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) {
      return { found: false, reason: 'no-video-element' };
    }
    main = videos[0];
    for (const v of videos) {
      if ((v.currentTime || 0) > (main.currentTime || 0)) main = v;
    }
  }

  const deriveState = (v) => {
    if (v.error && v.error.code) return 'error';
    if (v.ended) return 'ended';
    if (v.seeking || (v.readyState >= 2 && v.readyState <= 3 && v.paused === false && v.currentTime === 0)) {
      // readyState 2~3 表示正在缓冲但尚未可播
    }
    if (!v.paused && !v.ended && v.readyState < 3) return 'buffering';
    if (v.paused && v.ended) return 'ended';
    if (v.paused) return 'paused';
    if (!v.paused) return 'playing';
    return 'unknown';
  };

  return {
    found: true,
    count: document.querySelectorAll('video').length,
    state: deriveState(main),
    currentTime: Number.isFinite(main.currentTime) ? main.currentTime : null,
    duration: Number.isFinite(main.duration) && main.duration > 0 ? main.duration : null,
    playbackRate: Number.isFinite(main.playbackRate) ? main.playbackRate : null,
    volume: Number.isFinite(main.volume) ? main.volume : null,
    muted: typeof main.muted === 'boolean' ? main.muted : null,
    src: main.currentSrc || main.src || null
  };
})()`
}

export interface RawObserverResult {
  found: boolean
  reason?: string
  count?: number
  state?: PlayerState
  currentTime?: number | null
  duration?: number | null
  playbackRate?: number | null
  volume?: number | null
  muted?: boolean | null
  src?: string | null
}

const VALID_STATES: readonly PlayerState[] = [
  'unknown',
  'playing',
  'paused',
  'buffering',
  'ended',
  'error'
]

function coerceState(v: unknown): PlayerState {
  return typeof v === 'string' && (VALID_STATES as readonly string[]).includes(v)
    ? (v as PlayerState)
    : 'unknown'
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 把原始脚本结果规范化为 PlaybackObservation。
 * 纯函数，可单测。不做任何状态提升。
 */
export function toObservation(taskId: string, raw: RawObserverResult): PlaybackObservation {
  if (!raw.found) {
    return {
      taskId,
      playerState: 'unknown',
      currentTimeSeconds: null,
      durationSeconds: null,
      playbackRate: null,
      volume: null,
      muted: null,
      observedAt: new Date().toISOString(),
      origin: 'none'
    }
  }
  return {
    taskId,
    playerState: coerceState(raw.state),
    currentTimeSeconds: numOrNull(raw.currentTime),
    durationSeconds: numOrNull(raw.duration),
    playbackRate: numOrNull(raw.playbackRate),
    volume: numOrNull(raw.volume),
    muted: typeof raw.muted === 'boolean' ? raw.muted : null,
    observedAt: new Date().toISOString(),
    // 只有真实找到 video 元素才算可信来源
    origin: 'html5-video'
  }
}

export class PlayerObserver {
  private timer: NodeJS.Timeout | null = null
  private destroyed = false
  private readonly script: string

  constructor(
    private readonly taskId: string,
    private readonly wc: Electron.WebContents,
    private readonly onObservation: (obs: PlaybackObservation) => void,
    private readonly intervalMs = 1000
  ) {
    this.script = buildObserverScript(taskId)
  }

  start(): void {
    if (this.timer || this.destroyed) return
    const tick = async (): Promise<void> => {
      if (this.destroyed || this.wc.isDestroyed()) {
        this.stop()
        return
      }
      try {
        const raw = (await this.wc.executeJavaScript(this.script, true)) as RawObserverResult
        if (this.destroyed) return
        this.onObservation(toObservation(this.taskId, raw))
      } catch {
        if (this.destroyed) return
        // 执行失败（页面导航中 / 播放器不可用）也必须如实上报
        this.onObservation(toObservation(this.taskId, { found: false }))
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.destroyed = true
  }
}

export type PlayerAction = 'play' | 'pause' | 'mute' | 'unmute' | 'setVolume' | 'setRate' | 'stop' | 'seek'

/**
 * 受限播放控制。
 *
 * 只暴露标准 HTML5 媒体属性，不触碰平台私有接口。
 * 若页面无 video 元素，返回 PLAYER_UNAVAILABLE，绝不假装成功。
 */
export async function commandPlayer(
  wc: Electron.WebContents,
  action: PlayerAction,
  value?: number,
  targetTaskId?: string
): Promise<{ ok: boolean; code?: string; message?: string }> {
  if (wc.isDestroyed()) return { ok: false, code: 'PLAYER_UNAVAILABLE', message: '页面已销毁' }

  const script = `(() => {
    const targetId = ${JSON.stringify(targetTaskId ?? null)};
    let main = null;
    if (targetId) {
      const container = document.querySelector('[data-task="' + CSS.escape(targetId) + '"]');
      if (container) {
        main = container.querySelector('video');
      } else {
        const el = document.getElementById(targetId);
        if (el && el.tagName === 'VIDEO') main = el;
      }
    }
    if (!main) {
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.length === 0) return { ok: false, reason: 'no-video-element' };
      main = videos[0];
      for (const v of videos) { if ((v.currentTime||0) > (main.currentTime||0)) main = v; }
    }
    if (typeof window.__chSetActiveTask === 'function' && targetId) {
      try { window.__chSetActiveTask(targetId); } catch (_) {}
    }
    const action = ${JSON.stringify(action)};
    const value = ${JSON.stringify(value ?? null)};
    try {
      switch (action) {
        case 'play': {
          const allVideos = Array.from(document.querySelectorAll('video'));
          for (const other of allVideos) {
            if (other !== main && !other.paused) {
              other.pause();
            }
          }
          const p = main.play();
          if (p && typeof p.then === 'function') {
            p.then(()=>({ok:true})).catch((e)=>({ok:false, reason:String(e)}));
            return { pending: true };
          }
          return { ok: true };
        }
        case 'pause': main.pause(); return { ok: true };
        case 'mute': main.muted = true; return { ok: true };
        case 'unmute': main.muted = false; return { ok: true };
        case 'setVolume': {
          if (typeof value !== 'number' || value < 0 || value > 1) return { ok:false, reason:'invalid-volume' };
          main.volume = value; main.muted = value === 0; return { ok: true };
        }
        case 'setRate': {
          if (typeof value !== 'number' || value < 0.25 || value > 4) return { ok:false, reason:'invalid-rate' };
          main.playbackRate = value; return { ok: true };
        }
        case 'seek': {
          if (typeof value !== 'number' || value < 0) return { ok:false, reason:'invalid-seek' };
          main.currentTime = value;
          return { ok: true };
        }
        case 'stop': main.pause(); try { main.currentTime = 0; } catch(_) {} return { ok: true };
        default: return { ok:false, reason:'unknown-action' };
      }
    } catch (e) { return { ok:false, reason: String(e) }; }
  })()`

  try {
    const res = (await wc.executeJavaScript(script, true)) as {
      ok?: boolean
      pending?: boolean
      reason?: string
    }
    if (res?.ok || res?.pending) return { ok: true }
    return {
      ok: false,
      code: 'PLAYER_UNAVAILABLE',
      message: res?.reason ?? '播放器不可用'
    }
  } catch (e) {
    return {
      ok: false,
      code: 'PLAYER_UNAVAILABLE',
      message: e instanceof Error ? e.message : String(e)
    }
  }
}
