// Structured diff between two canonicalized documents.
//
// The output is a flat list rather than a text patch because the interesting failures are
// single leaves — one key, one type — buried several levels down, and a text patch of a
// pretty-printed document buries them further.

const KIND = { missing: 'missing', extra: 'extra', value: 'value', type: 'type' }

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function join(path, key) {
  if (path === '') return String(key)
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`
}

const ABSENT = Symbol('absent')

function walk(expected, actual, path, out) {
  if (actual === ABSENT) {
    out.push({ path, kind: KIND.missing, expected, actual: undefined })
    return
  }
  if (expected === ABSENT) {
    out.push({ path, kind: KIND.extra, expected: undefined, actual })
    return
  }

  const te = typeOf(expected)
  const ta = typeOf(actual)
  if (te !== ta) {
    out.push({ path, kind: KIND.type, expected, actual })
    return
  }

  if (te === 'object') {
    for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)]).values()) {
      walk(
        Object.hasOwn(expected, k) ? expected[k] : ABSENT,
        Object.hasOwn(actual, k) ? actual[k] : ABSENT,
        join(path, k),
        out,
      )
    }
    return
  }

  if (te === 'array') {
    const n = Math.max(expected.length, actual.length)
    for (let i = 0; i < n; i++) {
      walk(
        i < expected.length ? expected[i] : ABSENT,
        i < actual.length ? actual[i] : ABSENT,
        join(path, i),
        out,
      )
    }
    return
  }

  if (expected !== actual) out.push({ path, kind: KIND.value, expected, actual })
}

/**
 * @returns {Array<{path: string, expected: unknown, actual: unknown, kind: 'missing'|'extra'|'value'|'type'}>}
 *   Empty when the two documents are identical. Both sides are expected to be canonicalized
 *   already — see canonicalize.mjs.
 */
export function diffCanonical(expected, actual) {
  const out = []
  walk(expected, actual, '', out)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

const show = (v) => (v === undefined ? '—' : JSON.stringify(v))

/** One human line per diff entry. Type mismatches name both types; that is the point. */
export function formatDiff(entries, indent = '    ') {
  return entries
    .map((e) => {
      const at = e.path || '<root>'
      switch (e.kind) {
        case KIND.missing:
          return `${indent}${at}: missing — expected ${show(e.expected)}`
        case KIND.extra:
          return `${indent}${at}: unexpected — got ${show(e.actual)}`
        case KIND.type:
          return `${indent}${at}: expected ${show(e.expected)} (${typeOf(e.expected)}), got ${show(e.actual)} (${typeOf(e.actual)})`
        default:
          return `${indent}${at}: expected ${show(e.expected)}, got ${show(e.actual)}`
      }
    })
    .join('\n')
}
