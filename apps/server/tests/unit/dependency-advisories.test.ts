/**
 * Dependency advisory guards (R4-prep).
 *
 * `fast-uri` (used by Fastify and by ajv) had several advisories fixed in
 * 3.1.9 and 4.2.3: GHSA-w74x-v6f9-j3xg (scheme spoofing via percent-encoded
 * scheme), GHSA-xhq7-xmqj-769h (path equivalence), GHSA-wjr9-j795-jxcr (host
 * confusion) and GHSA-333x-w4r6-6crp (scheme injection). This test fails if any
 * installed copy falls back below the patched release of its major line, for
 * example after a lockfile regeneration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every installed copy of a package, as recorded in package-lock.json. */
function installedVersions(name: string): Array<{ location: string; version: string }> {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  return Object.entries(lock.packages)
    .filter(([location]) => location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`))
    .map(([location, meta]) => ({ location, version: meta.version ?? '0.0.0' }));
}

const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
function atLeast(version: string, minimum: string): boolean {
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe('dependency advisories', () => {
  it('every installed fast-uri is at or above the patched release of its major line', () => {
    const copies = installedVersions('fast-uri');
    expect(copies.length).toBeGreaterThan(0);
    const patched: Record<string, string> = { '3': '3.1.9', '4': '4.2.3' };
    for (const { location, version } of copies) {
      const minimum = patched[version.split('.')[0]!];
      expect(minimum, `${location}: unexpected fast-uri major ${version}`).toBeDefined();
      expect(atLeast(version, minimum!), `${location}: fast-uri ${version} is below ${minimum}`).toBe(true);
    }
  });
});
