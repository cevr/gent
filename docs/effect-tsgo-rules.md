# Effect Tsgo Rules

Sources used:

- `/Users/cvr/.cache/repo/effect-ts/tsgo/README.md`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/internal/rules/rules.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/internal/rules/metadata.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/etscore/options.go`
- `/Users/cvr/.cache/repo/effect-ts/tsgo/etscore/options_parser.go`

`effect-tsgo` reads the Effect diagnostics from the `@effect/language-service`
plugin entry in `tsconfig.json`. Gent runs every rule as an error except
`strictBooleanExpressions` and pipe-shaped suggestions. Test files inherit the
same catalog, with `strictEffectProvide` disabled through an override because
test layers intentionally provide partial worlds.

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
| `asyncFunction`            | error    |
| `cryptoRandomUUID`         | error    |
| `cryptoRandomUUIDInEffect` | error    |
| `extendsNativeError`       | error    |
| `globalConsole`            | error    |
| `globalConsoleInEffect`    | error    |
| `globalDate`               | error    |
| `globalDateInEffect`       | error    |
| `globalFetch`              | error    |
| `globalFetchInEffect`      | error    |
| `globalRandom`             | error    |
| `globalRandomInEffect`     | error    |
| `globalTimers`             | error    |
| `globalTimersInEffect`     | error    |
| `instanceOfSchema`         | error    |
| `newPromise`               | error    |
| `nodeBuiltinImport`        | error    |
| `preferSchemaOverJson`     | error    |
| `processEnv`               | error    |
| `processEnvInEffect`       | error    |

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
