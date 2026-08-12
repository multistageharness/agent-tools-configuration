# Canonical Serialization

**Status:** normative for the fixture suite's own files; advisory for probes. RFC 2119 keywords
apply as in [`SPEC.md`](SPEC.md).

Five languages serializing the same object five ways would fail the conformance suite on key
order and float formatting long before they failed it on behavior. This document pins one
serialization so a diff means something.

---

## 1. The rules

1. **Key order.** Object keys MUST be sorted lexicographically by Unicode code point, at every
   depth. Not by locale, not by insertion order, not case-insensitively. `Z` sorts before `a`.
2. **Indentation and line endings.** Two spaces per level, LF line endings, exactly one trailing
   newline at end of file. No tabs, no CRLF.
3. **Paths.** Every path inside the document MUST be relative to the fixture's `tree/` directory
   and MUST use forward slashes on every platform, with no leading `./` and no trailing slash.
   `project/.config/mytool/config.toml`, never `.\project\...` and never an absolute path.
4. **Numbers.** Integers MUST be emitted with no decimal point and no exponent: `5432`, never
   `5432.0` and never `5.432e3`. Non-integers MUST be emitted in the shortest form that
   round-trips to the same value, and MUST NOT use exponent notation for any value that can be
   written without it. Negative zero MUST be emitted as `0`.
5. **Literals.** Booleans and null MUST be emitted as the JSON literals `true`, `false`, `null` —
   never as the strings `"true"`, `"false"`, `"null"`. This rule is load-bearing: the difference
   between the number `5432` and the string `"5432"` is exactly what the env-var coercion
   fixtures assert.
6. **Arrays.** Element order MUST be preserved. Arrays are never sorted — order is data.
7. **`sources` order.** Entries MUST be emitted in *application order* as defined by SPEC §3.1:
   lowest effective priority first. That is ascending `precedence`, with the one documented
   exception that a root's `.env` entry (precedence 3) is emitted inside that root's block,
   immediately after that root's structured files. Within a single precedence at a single root,
   entries follow load order — the SPEC §2.5 file order.
8. **Empty containers.** An empty object is `{}` and an empty array is `[]`. Neither is ever
   omitted, and neither is ever rendered as `null`.
9. **Strings.** UTF-8, with only the escapes JSON requires. Non-ASCII characters MUST NOT be
   `\u`-escaped.

---

## 2. What this binds

**`expected.json` files in the fixture suite MUST follow every rule above.** They are read by
humans in diffs, and an inconsistent one wastes a reviewer's time.

**Probes SHOULD follow them, and MUST NOT be failed for not following them.** A probe MAY emit
any valid JSON document with the right values in it — unsorted keys, four-space indent, all of it
fine.

**The runner MUST canonicalize both sides before diffing.** Expected and actual are both passed
through `runner/canonicalize.mjs`, and only then compared. Canonicalization is therefore a
convenience for the reader, not a conformance requirement for the implementer.

The one thing canonicalization does not paper over is *type*: `5432` and `"5432"` canonicalize to
different documents and MUST be reported as a mismatch, with both types named. Several of the
wrapped libraries stringify everything they read from the environment, so this is the single
most likely real failure, and it must never look like a formatting nit.

---

## 3. Worked example

Non-canonical but acceptable probe output:

```json
{"sources":[{"precedence":2,"path":"project/.config/mytool/config.toml","keys":["log","port"],"format":"toml"}],"found":true,"config":{"port":5432,"log":{"level":"debug"}}}
```

The same document canonicalized — and the form an `expected.json` MUST take:

```json
{
  "config": {
    "log": {
      "level": "debug"
    },
    "port": 5432
  },
  "found": true,
  "sources": [
    {
      "format": "toml",
      "keys": [
        "log",
        "port"
      ],
      "path": "project/.config/mytool/config.toml",
      "precedence": 2
    }
  ]
}
```
