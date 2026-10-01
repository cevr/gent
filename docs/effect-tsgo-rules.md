# Effect Tsgo Rules

`effect-tsgo` reads the Effect diagnostics from the `@effect/language-service`
plugin entry in the root `tsconfig.json`. Its `diagnosticSeverity` map, with
the comments beside it, is the one list of what runs and why: gent runs every
diagnostic as an error, except the style suggestions, `unstableApiUsage`, and
the diagnostics an oxlint rule holds at every site, so that one site takes one
suppression. The `overrides` there turn `strictEffectProvide` off in tests,
and, where oxlint drops the `effect/noGlobals` built-in bans, turn the matching diagnostics
back on for each global the file does not use.

The repository uses stable TypeScript 7 patched by `effect-tsgo patch`.
Package typecheck scripts invoke `tsc --noEmit`; the unpatched preview `tsgo`
binary is not part of the compiler path.
