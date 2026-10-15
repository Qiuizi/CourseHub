/**
 * 定位模拟测试（仅隔离测试 webContents）。
 *
 * 契约（开发文档 §7）：
 * 1. 用 CDP `Emulation.setGeolocationOverride` 下发坐标；
 * 2. 停止时 `Emulation.clearGeolocationOverride`，并覆盖
 *    调试器分离、刷新、导航、销毁、异常退出等全部清理路径；
 * 3. **覆盖坐标与授予权限是两件不同的事** —— 两者都要做，且都要验证；
 * 4. 必须读取测试页 navigator.geolocation 的实际返回再对比，
 *    不能因为指令下发成功就显示验收成功；
 * 5. 真实平台 Session 永不应用覆盖。
 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { GeoTestConfig, GeoTestRun } from '@shared/types'
import { validateGeoPoint, haversineMeters } from '@shared/geo'
import { TEST_PARTITION, testSession } from '../browser/platform-browser'

export interface GeoTestManagerEvents {
  onUpdate: (run: GeoTestRun) => void
}

let runCounter = 0

export class GeoTestManager {
  private view: WebContentsView | null = null
  private attached = false
  private win: BrowserWindow | null = null
  private debuggerAttached = false
  private current: GeoTestRun | null = null

  constructor(private readonly events: GeoTestManagerEvents) {}

  private emit(patch: Partial<GeoTestRun>): void {
    if (!this.current) return
    this.current = { ...this.current, ...patch }
    this.events.onUpdate(this.current)
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const view = new WebContentsView({
      webPreferences: {
        // 独立测试分区：与所有生产会话隔离
        session: testSession(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: undefined
      }
    })
    view.setBackgroundColor('#0b0f19')
    // 任何离开测试页的导航都视为需要清理
    view.webContents.on('did-start-navigation', () => {
      if (this.current?.status === 'active') {
        this.emit({ status: 'failed', error: '测试页发生导航，覆盖已失效' })
        void this.stop()
      }
    })
    this.view = view
    return view
  }

  private attach(win: BrowserWindow): WebContentsView {
    const view = this.ensureView()
    if (!this.attached) {
      win.contentView.addChildView(view)
      this.attached = true
    }
    this.win = win
    return view
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    if (width <= 0 || height <= 0) return
    this.view.setBounds({
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.floor(width),
      height: Math.floor(height)
    })
  }

  /**
   * 场景不可见时移除视图。
   * WebContentsView 不受 React z-index 约束，不主动移除就会带着旧 bounds
   * 浮在其它场景上面（v0.3 实测到的缺陷）。
   */
  setActive(active: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed() || !this.win) return
    if (!active) {
      if (this.attached) {
        this.win.contentView.removeChildView(this.view)
        this.attached = false
      }
      this.view.setVisible(false)
    } else if (this.current && this.current.status !== 'idle') {
      if (!this.attached) {
        this.win.contentView.addChildView(this.view)
        this.attached = true
      }
      this.view.setVisible(true)
    }
  }

  hide(): void {
    if (!this.view || this.view.webContents.isDestroyed() || !this.win) return
    if (this.attached) {
      this.win.contentView.removeChildView(this.view)
      this.attached = false
    }
  }

  /**
   * 启动一次定位覆盖。
   * 步骤：校验参数 -> 载入测试页 -> 授予 geolocation 权限 -> CDP 下发坐标 ->
   *       读取测试页实际读数 -> 与预设值对比。
   */
  async start(win: BrowserWindow, config: GeoTestConfig, fixtureUrl: string): Promise<GeoTestRun> {
    runCounter += 1
    const id = `geo-${Date.now()}-${runCounter}`

    const validation = validateGeoPoint({
      latitude: config.latitude,
      longitude: config.longitude,
      accuracyMeters: config.accuracyMeters
    })
    if (!validation.ok) {
      const run: GeoTestRun = {
        id,
        targetOrigin: config.targetOrigin,
        latitude: typeof config.latitude === 'number' ? config.latitude : 0,
        longitude: typeof config.longitude === 'number' ? config.longitude : 0,
        accuracyMeters: typeof config.accuracyMeters === 'number' ? config.accuracyMeters : 0,
        appliedAt: null,
        clearedAt: null,
        observedLocation: null,
        status: 'failed',
        error: `坐标非法: ${validation.errors.join(',')}`
      }
      this.current = run
      this.events.onUpdate(run)
      return run
    }

    const { latitude, longitude, accuracyMeters } = validation.point
    const run: GeoTestRun = {
      id,
      targetOrigin: config.targetOrigin,
      latitude,
      longitude,
      accuracyMeters,
      appliedAt: null,
      clearedAt: null,
      observedLocation: null,
      status: 'preparing',
      error: null
    }
    this.current = run
    this.events.onUpdate(run)

    const view = this.attach(win)
    const wc = view.webContents

    try {
      // 1) 先加载测试页
      await wc.loadURL(fixtureUrl)

      // 2) 授予 geolocation 权限（与坐标覆盖是两件独立的事）
      await wc.session.setPermissionRequestHandler((_w, permission, callback) => {
        callback(permission === 'geolocation')
      })

      // 3) 附着调试器并下发坐标覆盖
      wc.debugger.attach('1.3')
      this.debuggerAttached = true
      await wc.debugger.sendCommand('Emulation.setGeolocationOverride', {
        latitude,
        longitude,
        accuracy: accuracyMeters
      })

      this.emit({ appliedAt: new Date().toISOString(), status: 'active' })

      // 4) 读取测试页真实读数 —— 不能只凭指令成功就判成功
      const observed = await this.readObservedLocation(wc)
      if (!observed) {
        this.emit({
          status: 'failed',
          error: '坐标已下发，但测试页未能读回 geolocation（可能未授权或页面未调用）'
        })
        return this.current
      }

      const drift = haversineMeters(
        { latitude, longitude },
        { latitude: observed.latitude, longitude: observed.longitude }
      )
      // 覆盖坐标是精确的；容差仅吸收浏览器量化误差
      const tolerance = Math.max(accuracyMeters, 50)
      if (drift > tolerance) {
        this.emit({
          status: 'failed',
          error: `读数与下发值偏差 ${drift.toFixed(1)}m，超过容差 ${tolerance.toFixed(1)}m`,
          observedLocation: observed
        })
        return this.current
      }

      this.emit({ observedLocation: observed })
      return this.current
    } catch (e) {
      this.emit({
        status: 'failed',
        error: e instanceof Error ? e.message : String(e)
      })
      return this.current
    }
  }

  /** 从测试页读取 navigator.geolocation 的实际返回。 */
  private async readObservedLocation(
    wc: Electron.WebContents
  ): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
    const script = `new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      navigator.geolocation.getCurrentPosition(
        (pos) => done({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        (err) => done({ error: err.code, message: err.message }),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
      setTimeout(() => done(null), 9000);
    })`
    try {
      const res = (await wc.executeJavaScript(script, true)) as {
        latitude?: number
        longitude?: number
        accuracy?: number
        error?: number
        message?: string
      } | null
      if (!res || typeof res.latitude !== 'number' || typeof res.longitude !== 'number') return null
      return {
        latitude: res.latitude,
        longitude: res.longitude,
        accuracy: typeof res.accuracy === 'number' ? res.accuracy : 0
      }
    } catch {
      return null
    }
  }

  /**
   * 停止覆盖并清理。走完整清理路径，任何一步失败都要落到 cleared/failed，
   * 绝不静默留下悬挂覆盖。
   */
  async stop(): Promise<GeoTestRun | null> {
    if (!this.current) return null
    if (this.current.status === 'idle' || this.current.status === 'cleared') return this.current

    this.emit({ status: 'clearing' })
    const view = this.view
    let error: string | null = null

    if (view && !view.webContents.isDestroyed()) {
      const wc = view.webContents
      try {
        if (this.debuggerAttached && wc.debugger.isAttached()) {
          await wc.debugger.sendCommand('Emulation.clearGeolocationOverride')
          wc.debugger.detach()
        }
      } catch (e) {
        error = `清除覆盖失败: ${e instanceof Error ? e.message : String(e)}`
      }
      this.debuggerAttached = false
    }

    // 释放测试视图
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.attached && this.win) {
        this.win.contentView.removeChildView(this.view)
      }
      this.view.webContents.close()
    }    this.view = null
    this.attached = false

    this.emit({
      clearedAt: new Date().toISOString(),
      status: error ? 'failed' : 'cleared',
      error,
      // 停止后 observedLocation 必须清空，避免残留读数被误认为仍在覆盖
      observedLocation: null
    })
    return this.current
  }

  get activeRun(): GeoTestRun | null {
    return this.current
  }

  /** 进程退出兜底：同步清理，不 await。 */
  disposeSync(): void {
    try {
      const wc = this.view?.webContents
      if (wc && !wc.isDestroyed() && this.debuggerAttached && wc.debugger.isAttached()) {
        void wc.debugger.sendCommand('Emulation.clearGeolocationOverride').catch(() => undefined)
        wc.debugger.detach()
      }
      if (wc && !wc.isDestroyed()) wc.close()
    } catch {
      /* ignore */
    }
    this.view = null
    this.attached = false
    this.debuggerAttached = false
  }
}

export { TEST_PARTITION }
