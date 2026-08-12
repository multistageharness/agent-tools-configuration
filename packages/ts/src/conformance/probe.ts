/**
 * The conformance probe — the adapter between `packages/spec/PROBE.md` and `load()`.
 *
 * Small, and every rule in it exists because breaking it makes fixtures fail for reasons that
 * have nothing to do with the library.
 */

import { isAbsolute, relative, sep } from 'node:path'

import { isConfigError } from '../errors.js'
import { load } from '../index.js'
import type { LoadOptions } from '../types.js'

interface Args {
  packageName: string
  cwd: string
  home: string
  fixtureRoot: string
  env: Record<string, string>
  options: Record<string, unknown>
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  let packageName: string | undefined
  let cwd: string | undefined
  let home: string | undefined
  let fixtureRoot: string | undefined
  const env: Record<string, string> = {}
  let options: Record<string, unknown> = {}

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string
    const next = argv[i + 1]
    const value = (): string => {
      if (next === undefined) throw new UsageError(`${flag} requires a value`)
      i++
      return next
    }
    switch (flag) {
      case '--package-name':
        packageName = value()
        break
      case '--cwd':
        cwd = value()
        break
      case '--home':
        home = value()
        break
      case '--fixture-root':
        fixtureRoot = value()
        break
      case '--env': {
        const pair = value()
        const eq = pair.indexOf('=')
        if (eq < 1) throw new UsageError(`--env expects KEY=VALUE, got ${JSON.stringify(pair)}`)
        env[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '--options': {
        const json = value()
        try {
          options = JSON.parse(json) as Record<string, unknown>
        } catch (error) {
          throw new UsageError(`--options is not valid JSON: ${(error as Error).message}`)
        }
        break
      }
      default:
        throw new UsageError(`unknown flag ${JSON.stringify(flag)}`)
    }
  }

  if (packageName === undefined) throw new UsageError('missing required flag --package-name')
  if (cwd === undefined) throw new UsageError('missing required flag --cwd')
  if (home === undefined) throw new UsageError('missing required flag --home')
  if (fixtureRoot === undefined) throw new UsageError('missing required flag --fixture-root')
  return { packageName, cwd, home, fixtureRoot, env, options }
}

/** SPEC §6. Anything outside this set exits 2 rather than being quietly ignored. */
const KNOWN_OPTIONS = new Set([
  'strategy',
  'arrayMerge',
  'stopDir',
  'envPrefix',
  'profile',
  'strict',
  'defaults',
  'overrides',
])

function relativize(path: string, fixtureRoot: string): string {
  if (!isAbsolute(path)) return path
  const rewritten = relative(fixtureRoot, path)
  if (rewritten === '' || rewritten.startsWith('..')) return path.split(sep).join('/')
  return rewritten.split(sep).join('/')
}

async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }

  // An option this package does not support must exit 2, not be ignored: a probe that shrugs
  // off `arrayMerge` and still prints a result is claiming conformance it does not have.
  for (const key of Object.keys(args.options)) {
    if (!KNOWN_OPTIONS.has(key)) {
      process.stderr.write(`unsupported option ${JSON.stringify(key)} (SPEC §6)\n`)
      return 2
    }
  }

  const options: LoadOptions<undefined> = {
    ...(args.options as LoadOptions<undefined>),
    cwd: args.cwd,
    home: args.home,
    // Built only from --env. Never `...process.env`: this is the line that stops a developer's
    // exported MYTOOL_LOG__LEVEL from silently changing fixture results.
    env: args.env,
    relativeTo: args.fixtureRoot,
    onWarning: (message: string) => process.stderr.write(`${message}\n`),
  }

  try {
    const result = await load(args.packageName, options)
    process.stdout.write(JSON.stringify(result))
    return 0
  } catch (error) {
    if (isConfigError(error)) {
      const path = error.path === undefined ? undefined : relativize(error.path, args.fixtureRoot)
      process.stdout.write(
        JSON.stringify({
          error: {
            kind: error.kind,
            ...(path === undefined ? {} : { path }),
            ...(error.keyPath === undefined ? {} : { keyPath: error.keyPath }),
            message: error.message,
          },
        }),
      )
      return 1
    }
    // Anything that is not a ConfigError is this harness breaking, not the library rejecting
    // input: exit 2, so the runner reports the case as unproven rather than as a failure.
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 2
  }
}

process.exit(await main(process.argv.slice(2)))
