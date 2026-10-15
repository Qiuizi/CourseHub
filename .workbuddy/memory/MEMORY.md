# CourseHub 项目长期笔记

## 项目性质

Windows x64 桌面应用，课堂交互与学习任务**测试**工作台。
技术栈锁定：Electron 44 + electron-vite 4 + React 18 + TypeScript 5.9 + Tailwind 4。

## 不可动摇的设计原则

这些是**安全与诚实性**约束，不是风格偏好。任何改动若破坏它们，必须视为破坏性变更：

1. **检测到活动 ≠ 已完成签到**。
   `statusSource` 必须如实标注来源；本地记忆（`local_dedupe`）
   永远不能把状态升级为 `checked_in`，只有 `provider_api` 可以。
2. **播放器 ended ≠ 平台记完成**。
   `platformStatus` 只接受平台接口返回，播放器观测永不写入它。
   这条有专门回归测试（`tests/unit/video-status.test.ts`）。
3. **模型给答案 ≠ 页面已填/已提交**。
   模型只能产出 `TestActionPlan`（意图），无执行权；
   执行在隔离测试页按白名单操作，写操作需用户确认 + DOM 回读校验。
4. **定位覆盖成功 ≠ 平台验收成功**。
   覆盖坐标与授予 geolocation 权限是两件独立的事，两者都要验证。
   必须读回测试页实际值，不能凭指令下发成功就判成功。
5. **未知值存 `null`**，不用 0 / 空串 / 推算值冒充。
   时间缺失就不显示，不猜测。

## 故意不实现的能力（合规边界）

- 自动提交签到（对第三方平台提交欺骗性数据 + 位置伪造）
- 自动提交作业/考试答案（学术不端）
- 伪造视频观看心跳/进度
- 生产平台 Session 的地理定位覆盖
- 自动更新、开机自启注册表项

## 平台适配器现状

三个平台（chaoxing / yuketang / zhihuishu）**全部为骨架**，
所有读取能力标记 `unverified` 或 `unsupported`，返回空数组。

**这是刻意的**：在没有真实响应样本前写死解析逻辑，
只会得到「看起来能跑、实际静默失效」的模块——
这正是雨课堂插件当前的状态（失败静默，无告警）。

新增真实解析前必须先做：只读抓取真实响应 → 落盘样本 → 据此写解析 → 单测。

## 安全架构要点

- 每平台独立持久化 Session：`persist:coursehub-<platformId>`
- 远程平台页：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true`
  / **`preload: undefined`**（物理上无法触碰 IPC）
- 权限：`setPermissionRequestHandler` + `setPermissionCheckHandler` 均默认全拒
- 导航/弹窗/下载按 platformId + origin 白名单；下载事件挂在 **Session** 上（不是 webContents）
- 测试分区 `coursehub-test` 与所有生产会话隔离，只放行 geolocation
- DeepSeek Key 走 `safeStorage` 加密落盘，**preload 不提供任何读取明文的通道**
- 日志递归脱敏（apiKey/authorization/cookie/token/password/secret）

## 本机环境坑（每次跑 Electron 都要注意）

- **`ELECTRON_RUN_AS_NODE=1` 是沙箱默认设的**，不 unset 则 electron.exe 退化为普通 Node
- Playwright 启 Electron 必须传**项目根**，传 `out/` 会 exit 1
- 详见 `.workbuddy/memory/2026-10-15.md`

## 依赖版本锁定理由

- `@vitejs/plugin-react` 锁 **5.2.0**（6.x 要 vite 8，与 vite 7 冲突）
- TypeScript 锁 **5.9.3**（不用 7.x 原生重写版，风险高）
- electron-builder 需 `publish: null`（无 git 仓库时 updateInfo 阶段会崩）

## 验证入口

```bash
npx vitest run                                          # 116/116
npx tsc --noEmit -p tsconfig.node.json                  # 0 error
npx tsc --noEmit -p tsconfig.web.json                   # 0 error
unset ELECTRON_RUN_AS_NODE && node tests/e2e/run-e2e.mjs   # 20/20
unset ELECTRON_RUN_AS_NODE && node tests/e2e/capture-screen.mjs  # OS 级截图
```

完整验收记录见 `docs/验收记录.md`（v0.2）与 `docs/验收记录-v0.3.md`（UI 重构）。

## UI 设计系统（v0.3 起，基准 = D:/Downloads/coursehub_desktop.tsx）

浅色 Material 3，设计令牌集中在 `src/renderer/src/styles/index.css`：
`--ch-page #f0f4f9` / `--ch-surface #fff` / `--ch-accent #0b57d0` /
`--ch-accent-tint #e8f0fe` / `--ch-text #1f1f1f` / `--ch-text-2 #444746` /
`--ch-border #e2e8f0` / 卡片 24px、模态 28px、内块 16px / 播放器 `--ch-player #0f172a`。
深色主题用同一套令牌换值（`[data-theme='dark']`），不另写组件。
**改 UI 前先读原型 TSX，不要凭记忆调色。**

## 原生视图管理（易错，v0.3 踩过）

- WebContentsView **不受 React z-index 约束**，不用时必须 `setVisible(false)` 移除，
  否则带着旧 bounds 浮在其它场景上
- 切场景要确保视图已创建（`platform.open`），否则区域全白
- 想截图证明原生视图渲染，**只能用 OS 级屏幕捕获**，Playwright/Electron 截图都不含它
