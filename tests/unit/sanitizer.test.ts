import { describe, it, expect } from 'vitest'
import { Sanitizer, generateErrorFingerprint } from '../../src/shared/sanitizer'

describe('Sanitizer 诊断日志与错误脱敏规范', () => {
  it('屏蔽包含敏感键名的属性 (cookie, token, apikey, password, session, studentno)', () => {
    const raw = {
      user: 'test_user',
      cookie: 'UID=12345; session=secret_sess_token',
      api_key: ['sk-', 'abcdef1234567890', 'abcdef1234567890'].join(''),
      Authorization: 'Bearer eyJhbGciOi...',
      deepseekApiKey: ['sk-', '1122334455667788', '9900aabbccddeeff'].join(''),
      studentNo: '2023001002',
      normalField: '公开章节名'
    }

    const sanitized = Sanitizer.sanitize(raw) as Record<string, unknown>

    expect(sanitized.cookie).toBe('[REDACTED]')
    expect(sanitized.api_key).toBe('[REDACTED]')
    expect(sanitized.Authorization).toBe('[REDACTED]')
    expect(sanitized.deepseekApiKey).toBe('[REDACTED]')
    expect(sanitized.studentNo).toBe('[REDACTED]')
    expect(sanitized.normalField).toBe('公开章节名')
    expect(sanitized.user).toBe('test_user')
  })

  it('脱敏深层嵌套对象与数组中的敏感信息', () => {
    const nested = {
      level1: {
        level2: [
          { token: 'secret-token-123', name: 'safe-item' },
          { headers: { cookie: 'UID=xxx' } }
        ]
      }
    }

    const res = Sanitizer.sanitize(nested) as any
    expect(res.level1.level2[0].token).toBe('[REDACTED]')
    expect(res.level1.level2[0].name).toBe('safe-item')
    expect(res.level1.level2[1].headers.cookie).toBe('[REDACTED]')
  })

  it('脱敏字符串中出现的手机号与电子邮箱', () => {
    const text = '请联系学生张三 13812345678 或发送至 student_test@university.edu.cn 咨询'
    const sanitized = Sanitizer.sanitize(text) as string

    expect(sanitized).toContain('[PHONE_REDACTED]')
    expect(sanitized).not.toContain('13812345678')
    expect(sanitized).toContain('[EMAIL_REDACTED]')
    expect(sanitized).not.toContain('student_test@')
  })

  it('脱敏 Windows 用户个人主目录路径 (C:\\Users\\<用户名>\\...)', () => {
    const stack = `Error: Cannot load module
    at C:\\Users\\qiuizi_admin\\AppData\\Local\\CourseHub\\app.asar\\index.js:12:34
    at d:\\Users\\ZhangSan\\Desktop\\CourseHub\\src\\main.ts:56:78`

    const sanitized = Sanitizer.sanitize(stack) as string

    expect(sanitized).toContain('C:\\Users\\[USER_HOME]\\AppData')
    expect(sanitized).not.toContain('qiuizi_admin')
    expect(sanitized).toContain('d:\\Users\\[USER_HOME]\\Desktop')
    expect(sanitized).not.toContain('ZhangSan')
  })

  it('脱敏 URL 中附带的身份验证 Query 参数 (cpi, enc, token, ticket, etc.)', () => {
    const url = 'https://mooc1.chaoxing.com/mycourse/stu?courseId=1001&classId=2002&cpi=987654&enc=a1b2c3d4e5f6&token=session_token_xyz'
    const sanitized = Sanitizer.sanitize(url) as string

    expect(sanitized).toContain('courseId=[REDACTED_PARAM]')
    expect(sanitized).not.toContain('1001')
    expect(sanitized).toContain('cpi=[REDACTED_PARAM]')
    expect(sanitized).toContain('enc=[REDACTED_PARAM]')
    expect(sanitized).toContain('token=[REDACTED_PARAM]')
    expect(sanitized).not.toContain('987654')
    expect(sanitized).not.toContain('a1b2c3d4e5f6')
    expect(sanitized).not.toContain('session_token_xyz')
  })

  it('超长文本自动按 512 字符截断，防止大体积响应堆满日志', () => {
    const longStr = 'A'.repeat(800)
    const sanitized = Sanitizer.sanitize(longStr) as string

    expect(sanitized.length).toBeLessThan(600)
    expect(sanitized).toContain('[TRUNCATED]')
    expect(sanitized.startsWith('A'.repeat(512))).toBe(true)
  })

  it('generateErrorFingerprint 输出确定性 12 字符指纹 (FP-XXXX-XXXX)', () => {
    const fp1 = generateErrorFingerprint('chaoxing', 'PARSER_STRUCTURE_MISMATCH', 'Cannot read property id of undefined')
    const fp2 = generateErrorFingerprint('chaoxing', 'PARSER_STRUCTURE_MISMATCH', 'Cannot read property id of undefined')
    const fp3 = generateErrorFingerprint('yuketang', 'PARSER_STRUCTURE_MISMATCH', 'Cannot read property id of undefined')

    expect(fp1).toMatch(/^FP-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(fp1).toBe(fp2) // 相同错误产生相同指纹
    expect(fp1).not.toBe(fp3) // 平台不同产生不同指纹
  })
})
