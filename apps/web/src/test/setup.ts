import { afterAll, beforeAll, vi } from 'vitest'

/**
 * React Router uses `useLayoutEffect` internally. Server rendering is the
 * lightest way to assert component output without adding jsdom or a browser; the
 * warning is specific to that transport and not a product error.
 */
let originalError: typeof console.error | undefined

beforeAll(() => {
  originalError = console.error
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) {
      return
    }
    originalError?.(...args)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})
