/**
 * Process entry: every "off" in the root `.oxlintrc.json`, root block and
 * overrides, suppresses a diagnostic.
 *
 * `bun run lint` runs it beside oxlint, so the gate and the pre-commit hook
 * fail on an "off" that suppresses nothing. `checkLintOffs` lints the whole
 * tree once with the probe copy of the config and fails closed on a probe
 * run that did not finish with a whole report.
 *
 * @module
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { checkLintOffs } from "./fixture-runner"

const program = checkLintOffs().pipe(
  Effect.catchTag("LintOffsError", (error) =>
    Effect.gen(function* () {
      yield* Console.error("Lint config offs failed:")
      yield* Effect.forEach(error.failures, (failure) => Console.error(`  ${failure}`), {
        discard: true,
      })
      return yield* Effect.fail("Lint config offs failed")
    }),
  ),
)

// The layer runs the check once as it is built; the scope closes after it.
// The bound catches a hang, not a slow run: the probe lints the whole tree
// with type-aware rules beside oxlint's own run, which takes 75-120 s on a
// 3-thread CI runner.
if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(program.pipe(Effect.scoped, Effect.timeout("300 seconds"))).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
    ),
  )
