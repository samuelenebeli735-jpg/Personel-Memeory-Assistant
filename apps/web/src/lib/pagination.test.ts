import { describe, expect, it } from 'vitest'
import {
  clampPage,
  pageAfterRemoval,
  pageToOffset,
  pageWindow,
  parsePageParam,
  rangeLabel,
  totalPages,
} from './pagination'

describe('pagination helpers', () => {
  it('reads the page parameter defensively', () => {
    expect(parsePageParam(null)).toBe(1)
    expect(parsePageParam('')).toBe(1)
    expect(parsePageParam('3')).toBe(3)
    expect(parsePageParam(' 4 ')).toBe(4)
    for (const bad of ['0', '-2', '2.5', 'abc', '1e3', '99999999999999999999']) {
      expect(parsePageParam(bad)).toBe(1)
    }
  })

  it('maps pages to offsets of 25', () => {
    expect(pageToOffset(1)).toBe(0)
    expect(pageToOffset(2)).toBe(25)
    expect(pageToOffset(5)).toBe(100)
  })

  it('counts pages and clamps out-of-range pages to the last one', () => {
    expect(totalPages(0)).toBe(1)
    expect(totalPages(25)).toBe(1)
    expect(totalPages(26)).toBe(2)
    expect(totalPages(132)).toBe(6)
    expect(clampPage(9, 132)).toBe(6)
    expect(clampPage(0, 132)).toBe(1)
    expect(clampPage(3, 0)).toBe(1)
  })

  it('labels the visible range', () => {
    expect(rangeLabel(2, 132)).toBe('26–50 of 132')
    expect(rangeLabel(6, 132)).toBe('126–132 of 132')
    expect(rangeLabel(1, 0)).toBe('0 of 0')
  })

  it('shows at most five numbers around the current page, keeping the ends', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3])
    expect(pageWindow(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pageWindow(1, 12)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 12])
    expect(pageWindow(6, 12)).toEqual([1, 'gap', 4, 5, 6, 7, 8, 'gap', 12])
    expect(pageWindow(12, 12)).toEqual([1, 'gap', 7, 8, 9, 10, 11, 12])
  })

  it('moves back a page when the last row of the last page is removed', () => {
    expect(pageAfterRemoval(3, 51, 1)).toEqual({ page: 2, moved: true })
    expect(pageAfterRemoval(2, 51, 1)).toEqual({ page: 2, moved: false })
    expect(pageAfterRemoval(1, 1, 1)).toEqual({ page: 1, moved: false })
  })
})
