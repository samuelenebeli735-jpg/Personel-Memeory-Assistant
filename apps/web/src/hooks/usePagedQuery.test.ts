import { describe, expect, it } from 'vitest'
import { resolveFetchedPage, withFilters, withPage } from './usePagedQuery'

describe('usePagedQuery URL rules', () => {
  it('omits page 1 from the URL and keeps other parameters', () => {
    const params = new URLSearchParams('status=PENDING&page=3')
    expect(withPage(params, 1).toString()).toBe('status=PENDING')
    expect(withPage(params, 4).toString()).toBe('status=PENDING&page=4')
    // The input is never mutated.
    expect(params.toString()).toBe('status=PENDING&page=3')
  })

  it('returns to page 1 whenever a filter changes', () => {
    const params = new URLSearchParams('status=PENDING&page=3')
    expect(withFilters(params, { status: 'DONE' }).toString()).toBe('status=DONE')
    expect(withFilters(params, { status: null, q: 'tiles' }).toString()).toBe('q=tiles')
    expect(withFilters(params, { q: '' }).toString()).toBe('status=PENDING')
  })

  it('clamps a page past the end to the last page', () => {
    expect(resolveFetchedPage(2, 60)).toEqual({ show: true })
    expect(resolveFetchedPage(3, 60)).toEqual({ show: true })
    expect(resolveFetchedPage(9, 60)).toEqual({ show: false, redirectTo: 3 })
    expect(resolveFetchedPage(2, 0)).toEqual({ show: false, redirectTo: 1 })
    expect(resolveFetchedPage(1, 0)).toEqual({ show: true })
  })
})
