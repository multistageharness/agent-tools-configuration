// Canonical serialization, per ../CANONICAL.md.
//
// Both the expected document and the probe's actual output pass through here before they are
// compared, so no implementation is ever failed for key order, path separators, or -0. Type is
// deliberately *not* normalized: "5432" and 5432 must stay different, because telling those
// apart is most of what this suite is for.

/** Normalize a path-valued string: forward slashes, no leading `./`, no trailing slash. */
export function canonicalPath(value) {
  let p = String(value).replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

function canonicalNumber(n) {
  if (Object.is(n, -0)) return 0
  return n
}

/**
 * Recursively canonicalize a parsed JSON value: object keys sorted by code point at every
 * depth, `path`-keyed strings normalized, negative zero flattened. Array order is preserved —
 * order is data.
 */
export function canonicalize(value, key = null) {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, null))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k], k)
    return out
  }
  if (typeof value === 'number') return canonicalNumber(value)
  if (typeof value === 'string' && key === 'path') return canonicalPath(value)
  return value
}

/** The canonical text form: two-space indent, LF, one trailing newline. */
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n'
}
