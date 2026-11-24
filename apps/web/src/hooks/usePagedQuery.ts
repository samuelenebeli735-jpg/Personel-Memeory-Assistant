/**
 * One hook for every paginated list (R2-05, refinement 4).
 *
 * - `?page=n` in the URL (page 1 omits it) maps to `limit=25&offset=25(n-1)`,
 *   so refresh, Back and shared links show the same page.
 * - A page past the end clamps to the last page and replaces the URL.
 * - Changing a filter returns to page 1.
 * - After a page change or a removal, focus moves to the list heading.
 * - Rows from the previous page stay visible while the next one loads.
 *
 * The URL and page decisions are pure functions below so they are unit tested
 * without a browser.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Paginated } from '../lib/api'
import { LIST_MAX_OFFSET, PAGE_SIZE, pageAfterRemoval, pageToOffset, parsePageParam, totalPages } from '../lib/pagination'

/** Returns new search params with `page` set (or removed for page 1). */
export function withPage(params: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(params)
  if (page <= 1) next.delete('page')
  else next.set('page', String(page))
  return next
}

/** Applies filter changes and always returns to page 1. Empty values are removed. */
export function withFilters(params: URLSearchParams, update: Record<string, string | null | undefined>): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === undefined || value === '') next.delete(key)
    else next.set(key, value)
  }
  next.delete('page')
  return next
}

/** Decides whether a fetched page can be shown or the URL must move to the last page. */
export function resolveFetchedPage(
  page: number,
  total: number,
  pageSize: number = PAGE_SIZE,
): { show: true } | { show: false; redirectTo: number } {
  const last = totalPages(total, pageSize)
  return page > last ? { show: false, redirectTo: last } : { show: true }
}

export type PagedStatus = 'loading' | 'ready' | 'error'

export interface PagedQuery<T> {
  page: number
  pageSize: number
  items: T[]
  total: number
  status: PagedStatus
  error: unknown
  setPage: (page: number) => void
  setFilters: (update: Record<string, string | null | undefined>) => void
  reload: () => void
  /** Call after deleting rows; moves to the new last page when needed. */
  afterRemoval: (count?: number) => { page: number; moved: boolean }
}

export function usePagedQuery<T>(
  fetchPage: (query: { limit: number; offset: number }) => Promise<Paginated<T>>,
  /** Values (usually from the URL) that define the result set, such as filters. */
  deps: ReadonlyArray<unknown>,
  options: {
    pageSize?: number
    headingRef?: RefObject<HTMLElement | null>
    /** Called when the requested page no longer exists and the list moved to `to`. */
    onClamp?: (from: number, to: number) => void
  } = {},
): PagedQuery<T> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const [params, setParams] = useSearchParams()
  const page = parsePageParam(params.get('page'))
  const [data, setData] = useState<Paginated<T> | null>(null)
  const [status, setStatus] = useState<PagedStatus>('loading')
  const [error, setError] = useState<unknown>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const focusHeadingNext = useRef(false)
  const headingRef = options.headingRef
  const onClampRef = useRef(options.onClamp)
  onClampRef.current = options.onClamp

  const writePage = useCallback(
    (next: number, replace: boolean) => setParams((prev) => withPage(prev, next), { replace }),
    [setParams],
  )

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    fetchRef
      // A page far past the end still returns the total (the API caps offset
      // at 10,000), so the list can clamp to the last page.
      .current({ limit: pageSize, offset: Math.min(pageToOffset(page, pageSize), LIST_MAX_OFFSET) })
      .then((result) => {
        if (cancelled) return
        const decision = resolveFetchedPage(page, result.total, pageSize)
        if (!decision.show) {
          focusHeadingNext.current = true
          onClampRef.current?.(page, decision.redirectTo)
          writePage(decision.redirectTo, true)
          return
        }
        setData(result)
        setError(null)
        setStatus('ready')
        if (focusHeadingNext.current) {
          focusHeadingNext.current = false
          headingRef?.current?.focus()
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
    // `deps` are the caller's filter values; the fetcher itself is read via the ref.
  }, [page, pageSize, reloadToken, writePage, headingRef, ...deps])

  const setPage = useCallback(
    (next: number) => {
      focusHeadingNext.current = true
      writePage(next, false)
    },
    [writePage],
  )

  const setFilters = useCallback(
    (update: Record<string, string | null | undefined>) => setParams((prev) => withFilters(prev, update)),
    [setParams],
  )

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  const afterRemoval = useCallback(
    (count = 1) => {
      const result = pageAfterRemoval(page, data?.total ?? 0, count, pageSize)
      focusHeadingNext.current = true
      if (result.moved) writePage(result.page, true)
      else setReloadToken((token) => token + 1)
      return result
    },
    [page, data, pageSize, writePage],
  )

  return {
    page,
    pageSize,
    items: data?.items ?? [],
    total: data?.total ?? 0,
    status,
    error,
    setPage,
    setFilters,
    reload,
    afterRemoval,
  }
}
