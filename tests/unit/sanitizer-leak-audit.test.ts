import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Sanitizer } from '../../src/shared/sanitizer'
import { Store } from '../../src/main/services/store'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import zlib from 'node:zlib'

describe('独立安全审计与合成敏感数据泄露防护测试 (Section 一)', () => {
  let tmpDir: string
  let store: Store

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursehub-leak-audit-'))
    store = new Store(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // 合成真实敏感数据靶场
  const SYNTHETIC_TARGETS = {
    cookie: 'JSESSIONID=A1B2C3D4E5F6071829; UID=10293847; route=c4ca4238a0b923820dcc509a6f75849b',
    deepseekKey: ['sk-', 'abcdef0123456789', 'abcdef0123456789'].join(''),
    jwtToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlNlY3JldFVzZXIifQ.abcdef1234567890',
    phone: '13812345678',
    idCard: '110101199003072345',
    email: 'secret_student@university.edu.cn',
    userPath: 'C:\\Users\\ConfidentialAdmin\\AppData\\Local\\CourseHub\\test.log',
    queryAuthUrl: 'https://mooc1.chaoxing.com/api?cpi=987654321&enc=super_secret_enc_token&token=tok_998877&studentno=202300099',
    examData: '学生答题答案: A, C, D; 本次期末测验总分: 98.5'
  }

  it('多层脱敏引擎消除所有合成敏感凭据与个人特征', () => {
    const rawPayload = {
      user: 'test_user',
      cookie: SYNTHETIC_TARGETS.cookie,
      api_key: SYNTHETIC_TARGETS.deepseekKey,
      jwt: SYNTHETIC_TARGETS.jwtToken,
      phone: SYNTHETIC_TARGETS.phone,
      idCard: SYNTHETIC_TARGETS.idCard,
      email: SYNTHETIC_TARGETS.email,
      stack: `Error at ${SYNTHETIC_TARGETS.userPath}:42`,
      url: SYNTHETIC_TARGETS.queryAuthUrl,
      exam: SYNTHETIC_TARGETS.examData
    }

    const redacted = Sanitizer.redact(rawPayload) as Record<string, unknown>

    // 1. 键名黑名单完全拦截
    expect(redacted.cookie).toBe('[REDACTED]')
    expect(redacted.api_key).toBe('[REDACTED]')
    expect(redacted.idCard).toBe('[REDACTED]')
    expect(redacted.exam).toBe('[REDACTED]')

    // 2. 字符串内部特征正则消除
    expect(redacted.stack).not.toContain('ConfidentialAdmin')
    expect(redacted.stack).toContain('C:\\Users\\[USER_HOME]\\AppData')

    expect(redacted.url).not.toContain('987654321')
    expect(redacted.url).not.toContain('super_secret_enc_token')
    expect(redacted.url).not.toContain('tok_998877')
    expect(redacted.url).not.toContain('202300099')
    expect(redacted.url).toContain('cpi=[REDACTED_PARAM]')

    // 3. 独立字符串脱敏验证
    const cleanPhone = Sanitizer.redactString(`联系电话: ${SYNTHETIC_TARGETS.phone}`)
    expect(cleanPhone).not.toContain('13812345678')
    expect(cleanPhone).toContain('[PHONE_REDACTED]')

    const cleanJwt = Sanitizer.redactString(`RawJWT: ${SYNTHETIC_TARGETS.jwtToken}`)
    expect(cleanJwt).not.toContain(SYNTHETIC_TARGETS.jwtToken)
    expect(cleanJwt).toContain('[JWT_REDACTED]')
  })

  it('物理导出诊断 ZIP 并逐文件解压核查：确认无敏感原始数据泄露', async () => {
    // 注入合成敏感错误事件
    await store.recordDiagnostic({
      module: 'chaoxing',
      platform: 'chaoxing',
      level: 'error',
      type: 'parse_error',
      code: 'PARSER_STRUCTURE_MISMATCH',
      summary: `请求失败: token=${SYNTHETIC_TARGETS.cookie} 用户路径=${SYNTHETIC_TARGETS.userPath}`,
      data: {
        rawCookie: SYNTHETIC_TARGETS.cookie,
        apiKey: SYNTHETIC_TARGETS.deepseekKey,
        reqUrl: SYNTHETIC_TARGETS.queryAuthUrl,
        studentPhone: SYNTHETIC_TARGETS.phone
      },
      stack: `Error: fail at ${SYNTHETIC_TARGETS.userPath}:10:20`
    })

    const exportResult = await store.exportDiagnosticZip({
      activePlatform: 'chaoxing',
      feedbackNote: `用户反馈备注：联系我 ${SYNTHETIC_TARGETS.email}，密码是 password=ConfidentialPass123`,
      targetDir: tmpDir,
      screenshotBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })

    // 读取生成的 ZIP 文件
    const zipData = await fs.readFile(exportResult.path)
    expect(zipData.readUInt32LE(0)).toBe(0x04034b50) // PKZIP Magic

    // 解析 ZIP 条目
    const entries = parseZipEntries(zipData)
    const fileNames = entries.map((e) => e.name)
    expect(fileNames).toContain('summary.json')
    expect(fileNames).toContain('errors.jsonl')
    expect(fileNames).toContain('environment.json')
    expect(fileNames).toContain('README.txt')
    expect(fileNames).toContain('screenshot.png')

    // 逐文件深入扫描是否含有任何未脱敏的合成凭据
    for (const entry of entries) {
      if (entry.name.endsWith('.png')) continue
      const content = entry.data.toString('utf8')

      expect(content).not.toContain(SYNTHETIC_TARGETS.cookie)
      expect(content).not.toContain(SYNTHETIC_TARGETS.deepseekKey)
      expect(content).not.toContain('ConfidentialAdmin')
      expect(content).not.toContain('ConfidentialPass123')
      expect(content).not.toContain('super_secret_enc_token')
      expect(content).not.toContain('13812345678')
      expect(content).not.toContain('secret_student@')
    }

    // 检查 README 声明
    const readme = entries.find((e) => e.name === 'README.txt')!.data.toString('utf8')
    expect(readme).toContain('隐私安全声明')
    expect(readme).toContain('不构成绝对“零泄露”数学证明')
  })

  it('用户未勾选附带诊断日志时：errors.jsonl 严格排除历史错误事件', async () => {
    await store.recordDiagnostic({
      module: 'system',
      level: 'error',
      type: 'test_error',
      code: 'PRIVATE_ERR_CODE',
      summary: '内部私有调试信息'
    })

    const exportResult = await store.exportDiagnosticZip({
      activePlatform: 'chaoxing',
      targetDir: tmpDir,
      includeErrors: false // 用户明确取消勾选诊断日志
    })

    const zipData = await fs.readFile(exportResult.path)
    const entries = parseZipEntries(zipData)
    const errorsEntry = entries.find((e) => e.name === 'errors.jsonl')
    expect(errorsEntry).toBeDefined()
    const content = errorsEntry!.data.toString('utf8')

    expect(content).not.toContain('PRIVATE_ERR_CODE')
    expect(content).toContain('用户未勾选附带系统诊断日志，已按隐私设定排除具体错误事件')
  })

  it('用户未附加截图时：ZIP 内严格禁止生成 screenshot.png', async () => {
    const exportResult = await store.exportDiagnosticZip({
      activePlatform: 'yuketang',
      targetDir: tmpDir,
      screenshotBase64: undefined // 用户未提供任何截图
    })

    const zipData = await fs.readFile(exportResult.path)
    const entries = parseZipEntries(zipData)
    const screenshotEntry = entries.find((e) => e.name === 'screenshot.png')
    expect(screenshotEntry).toBeUndefined()
  })

  it('脱敏预览内容与实际导出 summary.json 字段保持一致', async () => {
    const pkg = await store.buildDiagnosticPackage('chaoxing')
    const exportResult = await store.exportDiagnosticZip({
      activePlatform: 'chaoxing',
      targetDir: tmpDir
    })

    const zipData = await fs.readFile(exportResult.path)
    const entries = parseZipEntries(zipData)
    const summaryJson = JSON.parse(entries.find((e) => e.name === 'summary.json')!.data.toString('utf8'))

    const normalizeSummary = (s: string): string => s.replace(/生成时间: .*\n/, '')
    expect(normalizeSummary(summaryJson.summary)).toBe(normalizeSummary(pkg.summaryText))
    expect(summaryJson.manifest.app.version).toBe(pkg.manifest.app.version)
    expect(summaryJson.manifest.system.platform).toBe(pkg.manifest.system.platform)
    expect(summaryJson.manifest.runtime.activePlatform).toBe(pkg.manifest.runtime.activePlatform)
  })
})

/** 简易 ZIP 解包辅助函数 (解析 Local Headers 并 Deflate 解压) */
function parseZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = []
  let offset = 0

  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset)
    if (sig !== 0x04034b50) break // Not a local file header

    const compMethod = buf.readUInt16LE(offset + 8)
    const compSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)

    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen)
    const dataStart = offset + 30 + nameLen + extraLen
    const compressedData = buf.subarray(dataStart, dataStart + compSize)

    let data: Buffer
    if (compMethod === 0) {
      data = Buffer.from(compressedData)
    } else if (compMethod === 8) {
      data = zlib.inflateRawSync(compressedData)
    } else {
      throw new Error(`Unsupported compression method: ${compMethod}`)
    }

    entries.push({ name, data })
    offset = dataStart + compSize
  }

  return entries
}
