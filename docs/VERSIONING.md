# Versioning policy

Five packages, five registries, one specification. This document says how their version numbers
relate — a question that is cheap to answer now and expensive to answer after the first publish.

## The policy: independent versions, one shared spec version

**Each package versions on its own cadence.** `packages/ts` at 1.4.2 and `packages/rust` at
1.0.7 is a normal, healthy state.

**Every package declares which `SPEC.md` version it implements**, in its README and in its
package metadata where the ecosystem has a field for it. That declaration is the thing that ties
the five together — not the package version.

The alternative, lockstep versions across all five, was rejected. It forces four empty releases
every time one package has a patch: four changelogs saying "no changes", four sets of publish
credentials exercised for nothing, and four registries carrying versions that differ from their
predecessor by a version number. It also makes a fix in one ecosystem wait for four others to be
ready.

## The spec version

`packages/spec/SPEC.md` carries a version in its header, and it follows semantic versioning over
*observable behavior*, not over prose:

| Change to the spec | Spec version | What every package owes |
| --- | --- | --- |
| Wording, examples, clarification with no behavior change | patch | Nothing. Re-read it if you like. |
| A new optional feature, or a new option that defaults to today's behavior | minor | Nothing immediately. Implementing it is a minor bump in that package. |
| A change to observable behavior — search paths, filenames, merge rules | minor **of the spec**, and a **minor** bump in every package | Every package implements it and bumps. |
| A change to the error model or the precedence table | **major** of the spec, and a **major** bump in every package | Every package implements it and bumps major. |

**A language package may not ship a behavior change without a corresponding spec version.** If
an implementation is wrong, fixing it to match the spec is a patch. If the *spec* is wrong,
change the spec first, bump it, then fix the implementations. The order matters: it is the only
thing keeping five implementations from drifting one bug fix at a time.

Recording which spec version a package implements is what makes a mixed deployment diagnosable.
A team running `ts@2.1.0` (spec 1.2) and `py@1.9.0` (spec 1.1) can see at a glance why the two
disagree, instead of discovering it from a support ticket.

## Pre-1.0

Until a package reaches 1.0.0, treat minor as the breaking-change slot, per the usual
convention. The spec's own version is already 1.0.0: it is the contract, and it was frozen
before any implementation existed, which is the point of Epic 01.

## Deprecation

An option or behavior being removed goes through one minor release where it warns on the
diagnostic channel, and is removed in the following major. The warning names the replacement.

Because the packages version independently, a deprecation lands in each ecosystem when that
package next releases — so the deprecation *window* is measured in that package's releases, not
in wall-clock time.

## Changelogs

Each package keeps its own changelog, in that ecosystem's convention. An entry that implements a
spec change names the spec version it brings the package up to. That single habit is what makes
"which of these five is behind?" answerable without reading code.
