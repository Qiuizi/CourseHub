/**
 * 轻量纯 Node.js ZIP 归档打包器（零第三方依赖）。
 *
 * 遵循 PKZIP 2.0 基础规范：
 * - 支持 Deflate 算法（通过内置 zlib.deflateRawSync）
 * - 支持标准 CRC-32 校验
 * - UTF-8 文件名编码
 * - Windows Explorer、7-Zip、macOS 归档实用工具均可正常解压。
 */

import zlib from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer | string
}

// 预计算 CRC-32 表
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[i] = c >>> 0
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralHeaders: Buffer[] = []
  let offset = 0

  const now = new Date()
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const entry of entries) {
    const rawData = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data
    const compressed = zlib.deflateRawSync(rawData)
    const crc = crc32(rawData)
    const fileNameBuf = Buffer.from(entry.name, 'utf8')

    // Local file header: 30 bytes + filename
    const localHeader = Buffer.alloc(30 + fileNameBuf.length)
    localHeader.writeUInt32LE(0x04034b50, 0) // Signature
    localHeader.writeUInt16LE(20, 4) // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6) // General purpose bit flag (Bit 11: UTF-8)
    localHeader.writeUInt16LE(8, 8) // Compression method: Deflate
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18) // Compressed size
    localHeader.writeUInt32LE(rawData.length, 22) // Uncompressed size
    localHeader.writeUInt16LE(fileNameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // Extra field length
    fileNameBuf.copy(localHeader, 30)

    localHeaders.push(localHeader, compressed)

    // Central directory header: 46 bytes + filename
    const centralHeader = Buffer.alloc(46 + fileNameBuf.length)
    centralHeader.writeUInt32LE(0x02014b50, 0) // Central directory signature
    centralHeader.writeUInt16LE(20, 4) // Version made by
    centralHeader.writeUInt16LE(20, 6) // Version needed
    centralHeader.writeUInt16LE(0x0800, 8) // UTF-8
    centralHeader.writeUInt16LE(8, 10) // Deflate
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(rawData.length, 24)
    centralHeader.writeUInt16LE(fileNameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // Extra field length
    centralHeader.writeUInt16LE(0, 32) // File comment length
    centralHeader.writeUInt16LE(0, 34) // Disk number start
    centralHeader.writeUInt16LE(0, 36) // Internal file attributes
    centralHeader.writeUInt32LE(0, 38) // External file attributes
    centralHeader.writeUInt32LE(offset, 42) // Relative offset of local header
    fileNameBuf.copy(centralHeader, 46)

    centralHeaders.push(centralHeader)

    offset += localHeader.length + compressed.length
  }

  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0)
  const centralDirOffset = offset

  // End of central directory record: 22 bytes
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // Disk number
  eocd.writeUInt16LE(0, 6) // Start disk
  eocd.writeUInt16LE(entries.length, 8) // Entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // Total entries
  eocd.writeUInt32LE(centralDirSize, 12)
  eocd.writeUInt32LE(centralDirOffset, 16)
  eocd.writeUInt16LE(0, 20) // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd])
}
