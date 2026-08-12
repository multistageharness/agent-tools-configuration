/**
 * The environment-variable layer — SPEC §4.5 — and the name mapping `.env` files share with it
 * (SPEC §4.6).
 *
 * The coercion rule is the one every other language in this repository has to match exactly:
 * `MYTOOL_PORT=5432` is the **number** 5432, and `MYTOOL_NAME=5432abc` is the string. It is
 * spelled as parse-as-JSON-or-keep-the-string because JSON is the one grammar all five
 * ecosystems already have; anything richer would be a grammar each of them would approximate
 * differently.
 */

/**
 * Variable name (prefix already stripped) to key path: lowercase, split on `__`, and leave a
 * single `_` alone — `SOME_KEY` is the single key `some_key`, not `some.key`.
 */
export function envKeyPath(name: string): string[] {
  return name
    .toLowerCase()
    .split('__')
    .filter((segment) => segment !== '')
}

/** SPEC §4.5 step 5. `wasQuoted` short-circuits it for `.env` values written inside quotes. */
export function coerceValue(raw: string, wasQuoted = false): unknown {
  if (wasQuoted) return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Write `value` at `path`, creating plain objects along the way and replacing non-objects. */
export function assignPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  const leaf = path.at(-1)
  if (leaf === undefined) return
  let node = target
  for (const segment of path.slice(0, -1)) {
    const existing = node[segment]
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      node[segment] = {}
    }
    node = node[segment] as Record<string, unknown>
  }
  node[leaf] = value
}

/**
 * Layer 4. `env` is required and is never defaulted to `process.env` in here: the probe and
 * every test depend on an exported `MYTOOL_*` in the developer's shell being unable to reach
 * this function.
 */
export function envLayer(
  env: Record<string, string | undefined>,
  prefix: string,
  onWarning?: (message: string) => void,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const marker = `${prefix}_`
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.startsWith(marker)) continue
    const path = envKeyPath(name.slice(marker.length))
    if (path.length === 0) {
      onWarning?.(`ignoring ${name}: it maps to an empty key path`)
      continue
    }
    assignPath(result, path, coerceValue(raw))
  }
  return result
}
