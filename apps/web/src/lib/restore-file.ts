/**
 * Restore file checks done in the browser before anything is uploaded (R2-06,
 * refinements 2 and 3). The server repeats every check on the bytes it
 * receives; these exist so a wrong file is refused without sending it.
 */

/** Same limit as POST /api/restore/file (decision D5). */
export const RESTORE_MAX_BYTES = 25 * 1024 * 1024

/** Newest export schema this build can restore. */
export const SUPPORTED_SCHEMA_VERSION = 1

export interface ExportFileSummary {
  schemaVersion: number
  exportedAt: string | null
  /** Rows per table in the file, for the confirmation. */
  counts: Record<string, number>
}

export type ExportFileCheck = { ok: true; summary: ExportFileSummary } | { ok: false; message: string }

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Checks size, encoding, JSON and the export's shape and version. */
export function checkExportFile(bytes: Uint8Array): ExportFileCheck {
  if (bytes.byteLength > RESTORE_MAX_BYTES) {
    return {
      ok: false,
      message: `This file is ${formatBytes(bytes.byteLength)}. Restore accepts files up to 25 MB. Nothing was uploaded.`,
    }
  }
  if (bytes.byteLength === 0) return { ok: false, message: 'This file is empty. Nothing was uploaded.' }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, message: 'This file isn’t text, so it isn’t a Recall export. Nothing was uploaded.' }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: 'This file isn’t valid JSON, so it isn’t a Recall export. Nothing was uploaded.' }
  }

  const bundle = parsed as { schemaVersion?: unknown; exportedAt?: unknown; data?: unknown }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof bundle.schemaVersion !== 'number' ||
    typeof bundle.data !== 'object' ||
    bundle.data === null
  ) {
    return { ok: false, message: 'This JSON file isn’t a Recall export. Nothing was uploaded.' }
  }
  if (bundle.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `This export was written by a newer version of Recall (schema ${bundle.schemaVersion}); this one understands up to ${SUPPORTED_SCHEMA_VERSION}. Nothing was uploaded.`,
    }
  }
  const counts: Record<string, number> = {}
  for (const [table, rows] of Object.entries(bundle.data as Record<string, unknown>)) {
    if (Array.isArray(rows)) counts[table] = rows.length
  }
  return {
    ok: true,
    summary: {
      schemaVersion: bundle.schemaVersion,
      exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null,
      counts,
    },
  }
}

/** Lower-case hex SHA-256 of the exact bytes (matches the server's). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "3f2a…9c1d": enough to tell files apart on screen. */
export function shortFingerprint(sha256: string): string {
  return sha256.length > 8 ? `${sha256.slice(0, 4)}…${sha256.slice(-4)}` : sha256
}

/** Records the report would add (settings excluded from the "records" count). */
export function totalToAdd(inserted: Record<string, number>): number {
  return Object.entries(inserted)
    .filter(([table]) => table !== 'settings')
    .reduce((sum, [, count]) => sum + count, 0)
}

/** "captureTags" → "Capture tags" */
export function tableLabel(table: string): string {
  const words = table.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
