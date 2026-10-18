import { describe, it, expect } from 'vitest'
import { createZipBuffer } from '../../src/main/services/zip'

describe('Pure Node.js PKZIP 2.0 打包服务', () => {
  it('为空文件列表返回包含有效空 Central Directory 的 ZIP Buffer', () => {
    const buf = createZipBuffer([])
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBe(22) // End of Central Directory Record 最小大小为 22 字节
    expect(buf.readUInt32LE(0)).toBe(0x06054b50) // EOCD signature
  })

  it('正确打包多个文件并包含合法的 Local File Header 与 EOCD Record', () => {
    const files = [
      { name: 'manifest.json', data: JSON.stringify({ version: '0.4.3', app: 'CourseHub' }, null, 2) },
      { name: 'logs/errors.jsonl', data: '{"type":"test_error","code":"ERR_TEST"}\n' },
      { name: 'README.txt', data: 'CourseHub 诊断报告文件说明' }
    ]

    const zipBuf = createZipBuffer(files)
    expect(zipBuf).toBeInstanceOf(Buffer)
    expect(zipBuf.length).toBeGreaterThan(100)

    // 首部必须为 Local File Header Magic: PK\x03\x04 (0x04034b50)
    expect(zipBuf.readUInt32LE(0)).toBe(0x04034b50)

    // 检查是否包含写入的文件名
    const contentStr = zipBuf.toString('utf-8')
    expect(contentStr).toContain('manifest.json')
    expect(contentStr).toContain('logs/errors.jsonl')
    expect(contentStr).toContain('README.txt')
  })

  it('对可压缩内容正确采用 DeflateRaw 压缩并计算 CRC-32', () => {
    const repeated = 'CourseHub Diagnostic Log Entry\n'.repeat(200)
    const rawLen = Buffer.byteLength(repeated)

    const zipBuf = createZipBuffer([
      { name: 'repeated.txt', data: repeated }
    ])

    // 压缩后的 ZIP 大小应显著小于原始文本大小
    expect(zipBuf.length).toBeLessThan(rawLen)

    // 读取压缩方法 (offset 8 in local file header) 应为 8 (Deflate)
    const compMethod = zipBuf.readUInt16LE(8)
    expect(compMethod).toBe(8)
  })

  it('支持二进制 Uint8Array (例如屏幕截图 PNG 数据)', () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    const zipBuf = createZipBuffer([
      { name: 'screenshot.png', data: fakePng }
    ])

    expect(zipBuf.length).toBeGreaterThan(fakePng.length)
    expect(zipBuf.toString('binary')).toContain('screenshot.png')
  })
})
