/**
 * The dashboard CSP (R3-03) is one policy in three places: this constant, the
 * production Caddyfile and `vite preview` (where the browser suite runs). They
 * must never drift apart, and the policy must stay strict.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import viteConfig from '../vite.config'
import { DASHBOARD_CSP } from './csp'

const here = path.dirname(fileURLToPath(import.meta.url))
const caddyfile = fs.readFileSync(path.resolve(here, '../../../deploy/Caddyfile'), 'utf8')
const directives = new Map(
  DASHBOARD_CSP.split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/)
    return [name!, values] as const
  }),
)

describe('dashboard Content-Security-Policy', () => {
  it('the Caddyfile serves exactly this policy, once', () => {
    const served = [...caddyfile.matchAll(/header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1])
    expect(served).toEqual([DASHBOARD_CSP])
  })

  it('vite preview (the browser suite) serves exactly this policy', () => {
    const headers = (viteConfig as { preview?: { headers?: Record<string, string> } }).preview?.headers
    expect(headers?.['Content-Security-Policy']).toBe(DASHBOARD_CSP)
  })

  it('allows scripts and style sheets from this origin only, with no inline or eval exceptions', () => {
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(directives.get('style-src')).toEqual(["'self'"])
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(DASHBOARD_CSP).not.toMatch(/unsafe-eval|unsafe-hashes|strict-dynamic|\*|https?:|data:/)
  })

  it("has exactly one documented exception: inline style attributes", () => {
    const unsafe = [...directives].filter(([, values]) => values.includes("'unsafe-inline'")).map(([name]) => name)
    expect(unsafe).toEqual(['style-src-attr'])
  })

  it('blocks plugins, <base> rewriting and framing', () => {
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('base-uri')).toEqual(["'none'"])
    expect(directives.get('frame-ancestors')).toEqual(["'none'"])
    expect(directives.get('form-action')).toEqual(["'self'"])
  })

  it('the page has no inline script for the policy to block', () => {
    const html = fs.readFileSync(path.resolve(here, '../index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/)
      expect(body!.trim()).toBe('')
    }
    expect(html).not.toMatch(/<style\b/)
  })
})
