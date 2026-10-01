# Effect Tsgo Rules

Sources used:

- `/Users/cvr/.cache/repo/effect-ts/tsgo/README.md`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/internal/rules/rules.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/internal/rules/metadata.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/etscore/options.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/etscore/options_parser.go`

`effect-tsgo` reads the Effect diagnostics from the `@effect/language-service`
plugin entry in `tsconfig.json`. Gent runs every rule as an error except
`strictBooleanExpressions`, pipe-shaped suggestions, and the rules an oxlint
rule holds at every site, so one site takes one suppression:
`effect/noAsyncFunction` holds `asyncFunction`, `effect/noNodeBuiltinImport`
holds `nodeBuiltinImport`, and `effect/noGlobals` holds the `global*`,
`processEnv` and `cryptoRandomUUID` rules, including their `globalThis` and
alias spellings. `newPromise` stays an error, because `effect/noNewPromise`
misses `new globalThis.Promise` and an alias of `Promise`. The gamut driver,
its tests and the capture preload turn `effect/noGlobals` off, so overrides
turn the matching rules back on there for each global the file does not use.
Test files inherit the
same catalog, with `strictEffectProvide` disabled through an override because
test layers intentionally provide partial worlds.

The repository uses stable TypeScript 7 patched by `effect-tsgo patch`.
Package typecheck scripts invoke `tsc --noEmit`; the unpatched preview `tsgo`
binary is not part of the compiler path.

## Correctness

| Rule                          | Severity |
| ----------------------------- | -------- |
| `anyUnknownInErrorContext`    | error    |
| `classSelfMismatch`           | error    |
| `duplicatePackage`            | error    |
| `effectFnImplicitAny`         | error    |
| `floatingEffect`              | error    |
| `genericEffectServices`       | error    |
| `missingEffectContext`        | error    |
| `missingEffectError`          | error    |
| `missingLayerContext`         | error    |
| `missingReturnYieldStar`      | error    |
| `missingStarInYieldEffectGen` | error    |
| `nonObjectEffectServiceType`  | error    |
| `outdatedApi`                 | error    |
| `overriddenSchemaConstructor` | error    |

## Anti Pattern

| Rule                            | Severity |
| ------------------------------- | -------- |
| `catchUnfailableEffect`         | error    |
| `effectFnIife`                  | error    |
| `effectGenUsesAdapter`          | error    |
| `effectInFailure`               | error    |
| `effectInVoidSuccess`           | error    |
| `globalErrorInEffectCatch`      | error    |
| `globalErrorInEffectFailure`    | error    |
| `layerMergeAllWithDependencies` | error    |
| `lazyPromiseInEffectSync`       | error    |
| `leakingRequirements`           | error    |
| `multipleEffectProvide`         | error    |
| `returnEffectInGen`             | error    |
| `runEffectInsideEffect`         | error    |
| `schemaSyncInEffect`            | error    |
| `scopeInLayerEffect`            | error    |
| `strictEffectProvide`           | error    |
| `tryCatchInEffectGen`           | error    |
| `unknownInEffectCatch`          | error    |

## Effect Native

| Rule                       | Severity |
| -------------------------- | -------- |
| `asyncFunction`            | off      |
| `cryptoRandomUUID`         | off      |
| `cryptoRandomUUIDInEffect` | off      |
| `extendsNativeError`       | error    |
| `globalConsole`            | off      |
| `globalConsoleInEffect`    | off      |
| `globalDate`               | off      |
| `globalDateInEffect`       | off      |
| `globalFetch`              | off      |
| `globalFetchInEffect`      | off      |
| `globalRandom`             | off      |
| `globalRandomInEffect`     | off      |
| `globalTimers`             | off      |
| `globalTimersInEffect`     | off      |
| `instanceOfSchema`         | error    |
| `newPromise`               | error    |
| `nodeBuiltinImport`        | off      |
| `preferSchemaOverJson`     | error    |
| `processEnv`               | off      |
| `processEnvInEffect`       | off      |

## Style

| Rule                             | Severity |
| -------------------------------- | -------- |
| `catchAllToMapError`             | error    |
| `deterministicKeys`              | error    |
| `effectDoNotation`               | error    |
| `effectFnOpportunity`            | error    |
| `effectMapFlatten`               | off      |
| `effectMapVoid`                  | error    |
| `effectSucceedWithVoid`          | error    |
| `missedPipeableOpportunity`      | off      |
| `missingEffectServiceDependency` | error    |
| `nestedEffectGenYield`           | error    |
| `redundantSchemaTagIdentifier`   | error    |
| `schemaStructWithTag`            | error    |
| `schemaUnionOfLiterals`          | error    |
| `serviceNotAsClass`              | error    |
| `strictBooleanExpressions`       | off      |
| `unnecessaryArrowBlock`          | error    |
| `unnecessaryEffectGen`           | error    |
| `unnecessaryFailYieldableError`  | error    |
| `unnecessaryPipe`                | off      |
| `unnecessaryPipeChain`           | off      |
