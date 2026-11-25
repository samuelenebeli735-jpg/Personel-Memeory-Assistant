import { describe, expect, it } from 'vitest'
import {
  checkExportFile,
  formatBytes,
  RESTORE_MAX_BYTES,
  sha256Hex,
  shortFingerprint,
  tableLabel,
  totalToAdd,
} from './restore-file'

const encode = (text: string) => new TextEncoder().encode(text)
const exportText = (schemaVersion = 1) =>
  JSON.stringify({ schemaVersion, exportedAt: '2026-11-20T10:00:00.000Z', settings: {}, counts: {}, data: { tasks: [{}, {}], notes: [] } })

describe('restore file checks (before upload)', () => {
  it('accepts a Recall export and counts its rows', () => {
    const result = checkExportFile(encode(exportText()))
    expect(result).toEqual({
      ok: true,
      summary: { schemaVersion: 1, exportedAt: '2026-11-20T10:00:00.000Z', counts: { tasks: 2, notes: 0 } },
    })
  })

  it('accepts a byte-order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(exportText())])
    expect(checkExportFile(withBom).ok).toBe(true)
  })

  it('refuses files over 25 MB, empty files, non-text and non-JSON', () => {
    const big = checkExportFile(new Uint8Array(RESTORE_MAX_BYTES + 1))
    expect(big.ok === false && big.message).toMatch(/up to 25 MB\. Nothing was uploaded\./)
    expect(checkExportFile(new Uint8Array()).ok).toBe(false)
    const binary = checkExportFile(new Uint8Array([0xff, 0xfe, 0x00]))
    expect(binary.ok === false && binary.message).toMatch(/isn’t text/)
    const broken = checkExportFile(encode('{ not json'))
    expect(broken.ok === false && broken.message).toMatch(/isn’t valid JSON/)
  })

  it('refuses JSON that is not an export, and newer schema versions', () => {
    const other = checkExportFile(encode(JSON.stringify({ hello: 'world' })))
    expect(other.ok === false && other.message).toMatch(/isn’t a Recall export/)
    const newer = checkExportFile(encode(exportText(2)))
    expect(newer.ok === false && newer.message).toMatch(/newer version of Recall \(schema 2\)/)
  })

  it('fingerprints the exact bytes the same way the server does', async () => {
    // The published SHA-256 test vector for 'abc' (FIPS 180-2), as the server's node:crypto computes it.
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    expect(await sha256Hex(encode('abc').buffer as ArrayBuffer)).toBe(expected)
    expect(shortFingerprint(expected)).toBe(`${expected.slice(0, 4)}…${expected.slice(-4)}`)
  })

  it('formats sizes, labels tables and counts records to add', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(tableLabel('captureTags')).toBe('Capture tags')
    expect(totalToAdd({ tasks: 3, notes: 2, settings: 1 })).toBe(5)
  })
})
