import { _electron as electron } from 'playwright'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execSync } from 'node:child_process'

function getInstalledExePath() {
  try {
    const raw = execSync(
      'powershell -Command "(Get-ItemProperty \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7f60d1a2-6bc4-519a-a278-504c3823e8af\').DisplayIcon"',
      { encoding: 'utf-8' }
    ).trim()
    const cleaned = raw.replace(/,\d+$/, '').replace(/^"|"$/g, '').trim()
    if (cleaned) return cleaned
  } catch {}
  return path.join(
    process.env.LOCALAPPDATA || 'C:\\Users\\123\\AppData\\Local',
    'Programs',
    'CourseHub Beta',
    'CourseHub Beta.exe'
  )
}

const installedExePath = getInstalledExePath()
const artifactDir = 'C:\\Users\\123\\.gemini\\antigravity\\brain\\8df6774d-b4d7-4d87-bda8-70eef4cd7aac'
const screenshotDir = path.join(artifactDir, 'screenshots')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getInstalledVersion() {
  try {
    const stdout = execSync(
      'powershell -Command "(Get-ItemProperty \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7f60d1a2-6bc4-519a-a278-504c3823e8af\').DisplayVersion"',
      { encoding: 'utf-8' }
    ).trim()
    return stdout
  } catch (err) {
    return 'unknown'
  }
}

function isPidAlive(pid) {
  if (!pid) return false
  try {
    const out = execSync(
      `powershell -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`,
      { encoding: 'utf-8' }
    ).trim()
    return out ? parseInt(out, 10) === pid : false
  } catch {
    return false
  }
}

function findInstallerProcesses() {
  try {
    const out = execSync(
      'powershell -Command "Get-Process | Where-Object { $_.ProcessName -match \'CourseHub-Setup\' } | Select-Object Id, ProcessName | ConvertTo-Json"',
      { encoding: 'utf-8' }
    ).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function findRunningBetaProcesses() {
  try {
    const out = execSync(
      'powershell -Command "Get-Process | Where-Object { $_.ProcessName -match \'^CourseHub Beta$\' } | Select-Object Id, ProcessName | ConvertTo-Json"',
      { encoding: 'utf-8' }
    ).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function stopRunningBetaProcesses() {
  try {
    execSync('powershell -Command "Stop-Process -Name \'CourseHub Beta\' -Force -ErrorAction SilentlyContinue"')
  } catch {}
}

const FROM_VERSION = process.env.UPGRADE_FROM_VERSION || '0.4.3-beta.5'
const TO_VERSION = process.env.UPGRADE_TO_VERSION || '0.4.3-beta.6'

async function run() {
  console.log(`================ 真实自动升级端到端验收测试 (${FROM_VERSION} -> ${TO_VERSION}) ================`)
  await fs.mkdir(screenshotDir, { recursive: true })

  // 1. 确认基线安装版本
  const initialVersion = getInstalledVersion()
  console.log(`[Step 1] 当前系统已安装基线版本 (注册表回读): ${initialVersion}`)
  if (initialVersion !== FROM_VERSION) {
    throw new Error(`当前安装版本为 ${initialVersion}，与测试基线 ${FROM_VERSION} 不一致，测试终止！`)
  }

  // 2. 启动基线版本 CourseHub
  console.log(`[Step 2] 正在拉起已安装的 CourseHub: ${installedExePath}`)
  const app = await electron.launch({
    executablePath: installedExePath,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  const oldPid = app.process()?.pid
  console.log(`[Step 2.1] 基线版本进程已启动，主进程 PID: ${oldPid}`)

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2000)

  const runtimeVersion = await app.evaluate(async ({ app }) => app.getVersion())
  console.log(`[Step 2.2] 运行时读取主进程版本: ${runtimeVersion}`)
  if (runtimeVersion !== FROM_VERSION) {
    await app.close().catch(() => {})
    throw new Error(`运行时版本不匹配：期望 ${FROM_VERSION}，实际为 ${runtimeVersion}`)
  }

  // 3. 触发检查更新
  console.log(`[Step 3] 触发检查更新，等待 ${TO_VERSION} 推送...`)
  await window.evaluate(async () => {
    void window.coursehub.updater.check(true)
  })

  // 等待更新弹窗出现（限时 35 秒）
  const dialogLocator = window.locator('[data-testid="update-dialog"]')
  await dialogLocator.waitFor({ state: 'visible', timeout: 35000 })
  console.log('[Step 3.1] 升级提示弹窗已渲染！')

  const promptScreenshot = path.join(screenshotDir, `v${TO_VERSION}-update-prompt.png`)
  await window.screenshot({ path: promptScreenshot })
  console.log(`[Step 3.2] 弹窗截图已保存: ${promptScreenshot}`)

  // 4. 点击「立即更新」启动下载
  console.log('[Step 4] 点击「立即更新」按钮启动下载...')
  const downloadBtn = window.locator('[data-testid="update-start-download"]')
  await downloadBtn.click()

  // 5. 等待下载完成与 SHA-512 校验 (最多 120 秒)
  console.log(`[Step 5] 正在下载 ${TO_VERSION} 安装包并校验 SHA-512...`)
  const installNowBtn = window.locator('[data-testid="update-install-now"]')
  await installNowBtn.waitFor({ state: 'visible', timeout: 120000 })
  console.log(`[状态 1: 下载成功] 安装包已就绪并完成 SHA-512 校验，「立即重启安装」按钮已就绪。`)

  const downloadScreenshot = path.join(screenshotDir, `v${TO_VERSION}-download-complete.png`)
  await window.screenshot({ path: downloadScreenshot })
  console.log(`[Step 5.1] 下载就绪截图已保存: ${downloadScreenshot}`)

  // 6. 点击「立即重启安装」
  console.log('[Step 6] 点击「立即重启安装」触发更新...')
  await installNowBtn.click()

  // 监控状态 2：旧进程平稳退出（不再调用 window.waitForTimeout 或 app.close）
  console.log(`[Step 6.1] 监控旧应用进程 (PID: ${oldPid}) 退出...`)
  let oldProcessExited = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    if (!isPidAlive(oldPid)) {
      oldProcessExited = true
      break
    }
  }

  if (!oldProcessExited) {
    throw new Error(`超时故障：原主进程 (PID: ${oldPid}) 在点击安装 15 秒后仍未退出！`)
  }
  console.log(`[状态 2: 旧进程退出] 原应用进程 PID ${oldPid} 已安全平稳退出。`)

  // 监控状态 3：NSIS 安装器启动
  console.log('[Step 6.2] 监控 NSIS 覆盖安装器拉起...')
  let installerPid = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const installers = findInstallerProcesses()
    if (installers.length > 0) {
      installerPid = installers[0].Id
      break
    }
    // 若安装器极速执行完毕且注册表已更新，也可快速通过
    if (getInstalledVersion() === TO_VERSION) {
      break
    }
  }
  console.log(`[状态 3: 安装器启动] NSIS 安装器启动确认${installerPid ? ` (PID: ${installerPid})` : ' (极速执行)'}。`)

  // 监控状态 4：NSIS 安装器执行完毕并验证注册表版本更新 (最多 45 秒)
  console.log(`[Step 6.3] 监控覆盖安装执行，轮询注册表 DisplayVersion 至 ${TO_VERSION}...`)
  let upgradedVersion = getInstalledVersion()
  for (let i = 0; i < 45; i++) {
    await sleep(1000)
    upgradedVersion = getInstalledVersion()
    const installers = findInstallerProcesses()
    if (upgradedVersion === TO_VERSION && installers.length === 0) {
      break
    }
  }

  if (upgradedVersion !== TO_VERSION) {
    const aliveInstallers = findInstallerProcesses()
    throw new Error(
      `覆盖安装超时：当前注册表版本仍为 ${upgradedVersion}，未更新为 ${TO_VERSION}！当前残留安装器: ${JSON.stringify(aliveInstallers)}`
    )
  }
  console.log(`[状态 4: 安装完成] NSIS 静默升级覆盖完成，注册表 DisplayVersion 已更新为: ${upgradedVersion}`)

  // 监控状态 5：新版本启动
  console.log('[Step 7] 监控新版本启动与功能复核...')
  await sleep(2000)

  // 检查是否由安装器 --force-run 自动拉起
  const autoLaunched = findRunningBetaProcesses()
  if (autoLaunched.length > 0) {
    console.log(`[状态 5: 新版本启动] 检测到安装器已通过 --force-run 自动拉起新版本 (PID: ${autoLaunched.map((p) => p.Id).join(', ')})。`)
    // 为避免 Playwright launch 产生单实例锁互斥冲突，先平稳释放自动拉起实例
    stopRunningBetaProcesses()
    await sleep(2000)
  } else {
    console.log('[状态 5: 新版本启动] 准备通过 Playwright 拉起新安装版本执行 UI 与 IPC 回归...')
  }

  // 启动升级后的新应用进行深度功能与界面验收
  console.log(`[Step 8] 使用 Playwright 启动升级后的 CourseHub: ${installedExePath}`)
  const upgradedApp = await electron.launch({
    executablePath: installedExePath,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  try {
    const upWindow = await upgradedApp.firstWindow()
    await upWindow.waitForLoadState('domcontentloaded')
    await upWindow.waitForTimeout(2000)

    // 8.1 验证新主进程版本
    const currentVer = await upgradedApp.evaluate(async ({ app }) => app.getVersion())
    console.log(`[Step 8.1] 升级后主进程版本回读: ${currentVer}`)
    if (currentVer !== TO_VERSION) {
      throw new Error(`版本异常：期望 ${TO_VERSION}，实际为 ${currentVer}`)
    }

    // 8.2 切换到「设置」页面检查更新卡片
    console.log('[Step 8.2] 切换至「设置」页面...')
    const settingsBtn = upWindow.locator('button:has-text("设置")')
    if ((await settingsBtn.count()) > 0) {
      await settingsBtn.first().click()
    } else {
      await upWindow.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const target = btns.find((b) => b.textContent?.includes('设置'))
        if (target) target.click()
      })
    }
    await upWindow.waitForTimeout(1500)

    // 8.3 触发一次手动「检查更新」，验证单层 IPC 返回
    console.log(`[Step 8.3] 在 ${TO_VERSION} 中点击「检查更新」，验证修复后的单层 IPC 响应...`)
    const checkBtn = upWindow.locator('[data-testid="settings-check-update"]')
    await checkBtn.click()
    await upWindow.waitForTimeout(3000)

    const postCheckState = await upWindow.evaluate(async () => {
      const res = await window.coursehub.updater.getState()
      return res
    })
    console.log(`[Step 8.4] ${TO_VERSION} 检查后 updater:get-state 返回:`, JSON.stringify(postCheckState))

    // 严格断言：无嵌套 data！
    if (postCheckState.ok !== true) {
      throw new Error(`get-state 失败: ${JSON.stringify(postCheckState)}`)
    }
    if (postCheckState.data.data !== undefined) {
      throw new Error(`严重回归：检测到仍存在嵌套 data: ${JSON.stringify(postCheckState)}`)
    }
    console.log('[Step 8.5] 验证通过：无嵌套 data，IPC 返回值合同完全正确！')

    // 8.4 保存截图
    const afterUpgradeScreenshot = path.join(screenshotDir, `v${TO_VERSION}-after-upgrade-settings.png`)
    await upWindow.screenshot({ path: afterUpgradeScreenshot })
    console.log(`[Step 8.6] 升级后设置页面截图已保存: ${afterUpgradeScreenshot}`)

    console.log(`================ 真实自动升级验收全部通过 (PASS) ================`)
  } finally {
    const upPid = upgradedApp.process()?.pid
    if (upPid && isPidAlive(upPid)) {
      try {
        await Promise.race([upgradedApp.close(), sleep(2000)])
      } catch {}
      if (isPidAlive(upPid)) {
        try {
          process.kill(upPid)
        } catch {}
      }
    }
    stopRunningBetaProcesses()
  }
}

run().catch((err) => {
  console.error('================ 自动升级验收失败 (FAIL) ================', err)
  process.exit(1)
})
