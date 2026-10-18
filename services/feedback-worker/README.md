# CourseHub 用户反馈与诊断数据网关服务 (Serverless Worker)

本服务基于 **Cloudflare Workers + Cloudflare R2** 构建，作为 CourseHub 客户端与 GitHub Issues 之间的安全无状态中继。

---

## 一、核心安全与架构设计

1. **客户端零密钥（Zero-Client-Secrets）**
   - 客户端（Electron 应用）**绝不内嵌** GitHub Personal Access Token (PAT) 或任何云端凭据。
   - 所有通信均通过本 Worker 进行中继与校验。
2. **诊断数据私有隔离存储**
   - 带有系统环境、错误调用栈和截图的完整诊断包**直接存入私有 Cloudflare R2 存储桶**。
   - 公开 GitHub Issues **仅同步脱敏后的标题、分类、系统类型与错误指纹**，杜绝个人隐私与堆栈泄露在公共网络上。
3. **错误指纹聚合与防刷去重**
   - 根据客户端上报的脱敏错误指纹（如 `FP-B39C-8A12`）自动检索开放中的 GitHub Issue。
   - 同一错误自动以 `+1` 形式在原有 Issue 下追加评论，避免数十名测试者重复报错造成 Issue 轰炸。
   - 内置 IP 频控（5 分钟内最多 10 次提交）。
4. **离线与断网容灾**
   - 若未配置本服务端，或用户处于离线网络环境，客户端会自动将脱敏诊断包保存为本地 ZIP，并提示可通过微信/QQ/邮件手动发送，系统不会伪造在线提交成功。

---

## 二、云端成本测算（Cloudflare 免费额度）

本方案完全基于 Cloudflare 免费层（Free Tier）设计，**无需绑定信用卡即可使用**：

| 云资源 | 免费套餐配额 | CourseHub 实际预估占用 (以 500 名测试者计) | 费用 |
| :--- | :--- | :--- | :--- |
| **Cloudflare Workers** | 100,000 次请求/天 | 约 50 ~ 200 次请求/天 | **$0.00** |
| **Workers CPU 时间** | 10ms / 请求 | 实际平均耗时约 2 ~ 4ms | **$0.00** |
| **Cloudflare R2 存储** | 10 GB / 月 免费存储 | 诊断 ZIP 压缩包平均约 20KB，500 份约为 10MB | **$0.00** |
| **R2 Class A 操作 (写)**| 1,000,000 次/月 | 约 500 次/月 | **$0.00** |
| **R2 下行流量费** | **$0 (R2 永久免外网流出费)** | 开发者按需下载诊断包 | **$0.00** |

> **结论**：本方案在小规模公测和好友试用阶段**完全 0 成本**，无需租用 VPS 或购置云数据库。

---

## 三、部署流程（5 分钟完成）

### 1. 前置准备
- 拥有一个 [Cloudflare 免费账号](https://dash.cloudflare.com/)。
- 本地安装了 Node.js (>= 18)。

### 2. 初始化与创建 R2 存储桶
在终端中进入本目录：
```powershell
cd services/feedback-worker
npm install
npx wrangler login
```
创建名为 `coursehub-diagnostics` 的私有 R2 存储桶：
```powershell
npx wrangler r2 bucket create coursehub-diagnostics
```

### 3. 配置 GitHub PAT 密钥
在 GitHub 生成一个具有 `Issues: Read & Write` 权限的 Fine-grained Personal Access Token：
```powershell
npx wrangler secret put GITHUB_TOKEN
# 终端提示时粘贴你的 GitHub Token
```

### 4. 部署至 Cloudflare 全球边缘节点
```powershell
npx wrangler deploy
```
部署成功后，Wrangler 会输出你的边缘域名，例如：
`https://coursehub-feedback-worker.<你的子域>.workers.dev`

---

## 四、客户端对接配置

在 CourseHub 源码或构建环境变量中配置反馈接口地址：

1. **开发/测试调试**：
   在打包前或本地测试中设置环境变量：
   ```powershell
   $env:COURSEHUB_FEEDBACK_ENDPOINT = "https://coursehub-feedback-worker.<你的子域>.workers.dev/api/feedback"
   ```
2. **生产构建发布**：
   在构建脚本或 `electron-builder` 配置中作为环境变量注入。
3. **接口定义**：
   - 方式：`POST /api/feedback`
   - 请求体格式（JSON）：
     ```json
     {
       "category": "course_sync",
       "description": "点击同步后学习通课程列表为空",
       "reproductionSteps": "登录后切换到学习通标签页，点击刷新按钮",
       "systemInfo": {
         "appVersion": "0.4.3-beta",
         "os": "Windows 11 (win32)",
         "arch": "x64",
         "timestamp": 1729267200000
       },
       "diagnosticsSummary": {
         "totalErrors": 1,
         "recentCodes": ["SYNC_LIST_EMPTY"],
         "activePlatform": "chaoxing",
         "errorFingerprint": "FP-8B29-4FA1"
       },
       "diagnosticPackageBase64": "UEsDBBQAAAA...",
       "screenshotBase64": "data:image/png;base64,iVBORw..."
     }
     ```
   - 响应结构：
     ```json
     {
       "success": true,
       "feedbackId": "FB-20261019-AB12CD",
       "message": "反馈已成功提交！感谢您的宝贵建议与支持。",
       "issueUrl": "https://github.com/Qiuizi/CourseHub/issues/42",
       "storedDiagnostics": true
     }
     ```
