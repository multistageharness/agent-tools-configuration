/**
 * Test-only helpers. Excluded from the build (see tsconfig.json) and from the published
 * tarball.
 *
 * Every test builds its own tree under a temp directory and injects `cwd` and `home`. Nothing
 * in this package's tests may read the real working directory or the real home — a suite whose
 * results depend on the machine it runs on is not a suite.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const created: string[] = []

/**
 * Materialize `files` (path relative to the tree root → contents) under a fresh temp directory
 * and return its path. A path ending in `/` creates an empty directory.
 */
export function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'config-discovery-'))
  created.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath)
    if (relativePath.endsWith('/')) {
      mkdirSync(full, { recursive: true })
      continue
    }
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

/** Call from an `afterAll`. */
export function cleanupTrees(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** Collects warnings so a test can assert on the diagnostic as well as the behavior. */
export function warningCollector(): { warnings: string[]; onWarning: (message: string) => void } {
  const warnings: string[] = []
  return { warnings, onWarning: (message: string) => warnings.push(message) }
}
