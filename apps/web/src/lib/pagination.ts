/**
 * Pagination arithmetic shared by every list (R2-05).
 *
 * Pages are 1-based in the URL (`?page=n`, page 1 omits the parameter) and map
 * to `limit`/`offset` on the API. Everything here is pure so it can be unit
 * tested without a browser.
 */

export const PAGE_SIZE = 25

/** Largest offset the list and search APIs accept. */
export const SEARCH_MAX_OFFSET = 10_000
export const LIST_MAX_OFFSET = 10_000

export function totalPages(total: number, pageSize = PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Reads `?page=` defensively: anything that is not a positive integer is page 1. */
export function parsePageParam(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 1
  if (!/^\d+$/.test(value.trim())) return 1
  const page = Number(value.trim())
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

export function clampPage(page: number, total: number, pageSize = PAGE_SIZE): number {
  return Math.min(Math.max(1, Math.floor(page)), totalPages(total, pageSize))
}

export function pageToOffset(page: number, pageSize = PAGE_SIZE): number {
  return (Math.max(1, Math.floor(page)) - 1) * pageSize
}

/** "26–50 of 132"; an empty list reads "0 of 0". */
export function rangeLabel(page: number, total: number, pageSize = PAGE_SIZE): string {
  if (total <= 0) return '0 of 0'
  const from = pageToOffset(page, pageSize) + 1
  const to = Math.min(total, from + pageSize - 1)
  return `${from}–${to} of ${total}`
}

/**
 * Up to five page numbers around the current page, with the first and last
 * pages always reachable and gaps shown as an ellipsis.
 *
 *   pageWindow(1, 3)  -> [1, 2, 3]
 *   pageWindow(6, 12) -> [1, 'gap', 4, 5, 6, 7, 8, 'gap', 12]
 */
export function pageWindow(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const start = Math.max(2, Math.min(page - 2, pages - 5))
  const end = Math.min(pages - 1, Math.max(page + 2, 6))
  const items: Array<number | 'gap'> = [1]
  if (start > 2) items.push('gap')
  for (let p = start; p <= end; p += 1) items.push(p)
  if (end < pages - 1) items.push('gap')
  items.push(pages)
  return items
}

/**
 * After deleting rows, the current page may no longer exist. Returns the page
 * to show and whether it moved, so the UI can say so.
 */
export function pageAfterRemoval(
  page: number,
  totalBefore: number,
  removed: number,
  pageSize = PAGE_SIZE,
): { page: number; moved: boolean } {
  const remaining = Math.max(0, totalBefore - removed)
  const next = clampPage(page, remaining, pageSize)
  return { page: next, moved: next !== page }
}
