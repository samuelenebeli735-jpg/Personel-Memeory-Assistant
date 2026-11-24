import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, askApi, capturesApi, parseRetryAfter, READ_RETRY_DELAYS_MS, restoreApi, tasksApi } from './api'
import { describeError } from './errors'

type FetchCall = { url: string; init: RequestInit }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function stubFetch(responses: Array<Response | Error>) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const page = { items: [], total: 0, limit: 25, offset: 0 }

describe('API client retries', () => {
  it('retries a read up to twice on a 5xx, then succeeds', async () => {
    const calls = stubFetch([
      jsonResponse(503, { error: { code: 'UNAVAILABLE', message: 'x' } }),
      jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }),
      jsonResponse(200, page),
    ])
    const result = tasksApi.list()
    await vi.advanceTimersByTimeAsync(READ_RETRY_DELAYS_MS[0] + READ_RETRY_DELAYS_MS[1])
    await expect(result).resolves.toEqual(page)
    expect(calls).toHaveLength(3)
  })

  it('stops after 1 attempt + 2 retries of a read', async () => {
    const calls = stubFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')])
    const result = tasksApi.list().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    const error = await result
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('network')
    expect(calls).toHaveLength(3)
  })

  it('never retries a write, even on a 5xx or a network failure', async () => {
    let calls = stubFetch([jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } })])
    await expect(tasksApi.create({ title: 'Buy tiles' } as never)).rejects.toMatchObject({ status: 500 })
    expect(calls).toHaveLength(1)

    calls = stubFetch([new TypeError('fetch failed')])
    await expect(capturesApi.convert('c1', 'NOTE')).rejects.toMatchObject({ kind: 'network' })
    expect(calls).toHaveLength(1)
  })

  it('does not retry a 429 or a 4xx read', async () => {
    const calls = stubFetch([jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'retry-after': '14' })])
    const error = await tasksApi.list().catch((e: unknown) => e)
    expect(calls).toHaveLength(1)
    expect(error).toMatchObject({ status: 429, retryAfter: 14, code: 'RATE_LIMITED' })
    expect(describeError(error, 'Loading tasks').message).toBe('Try again in 14 s.')
  })

  it('times out a request that gets no answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      ),
    )
    const result = tasksApi.create({ title: 'x' } as never).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    const error = (await result) as ApiError
    expect(error.kind).toBe('timeout')
    expect(describeError(error, 'Saving the task', true).message).toContain('check before trying again')
  })
})

describe('API client contracts', () => {
  it('sends convert as { kind, force } (C1) and undo with force', async () => {
    const calls = stubFetch([jsonResponse(200, {}), jsonResponse(200, {})])
    await capturesApi.convert('c1', 'EVENT', true)
    await capturesApi.undo('c1', true)
    expect(calls[0]?.url).toBe('/api/captures/c1/convert')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: 'EVENT', force: true })
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ force: true })
  })

  it('has no capture update method (C2)', () => {
    expect('update' in capturesApi).toBe(false)
  })

  it('keeps the Ask question out of the URL', async () => {
    const calls = stubFetch([jsonResponse(200, { grounded: false, answer: '', evidence: [], provider: 'none', deterministic: true })])
    await askApi.ask('When is the dentist?')
    expect(calls[0]?.url).toBe('/api/ask')
    expect(calls[0]?.url).not.toContain('dentist')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ question: 'When is the dentist?' })
  })

  it('sends restore files as raw bytes with the hash in the query', async () => {
    const calls = stubFetch([jsonResponse(200, {}), jsonResponse(200, {})])
    const bytes = new TextEncoder().encode('{"schemaVersion":1}').buffer
    await restoreApi.check(bytes, 'abc123')
    await restoreApi.apply(bytes, 'abc123', 'tok456')
    expect(calls[0]?.url).toBe('/api/restore/file?dryRun=true&sha256=abc123')
    expect(calls[1]?.url).toBe('/api/restore/file?dryRun=false&sha256=abc123&checkToken=tok456')
    expect(calls[0]?.init.body).toBe(bytes)
    expect(calls[0]?.init.method).toBe('POST')
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('14')).toBe(14)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    const now = Date.parse('2026-11-24T10:00:00Z')
    expect(parseRetryAfter('Tue, 24 Nov 2026 10:00:30 GMT', now)).toBe(30)
  })
})
