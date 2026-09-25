/**
 * Process entry: every "off" in the root `.oxlintrc.json`, root block and
 * overrides, suppresses a diagnostic.
 *
 * `bun run lint` runs it beside oxlint, so the gate and the pre-commit hook
 * fail on an "off" that suppresses nothing. It lints the whole tree once with
 * the probe copy of the config (`lintWithoutOffs`), then gives the report to
 * `findUnneededOffs`.
 *
 * @module
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { labeledDiagnostics, lintWithoutOffs } from "./fixture-runner"
import { findUnneededOffs } from "./guards"

/** A run that lints fewer files than this read the wrong tree or no tree. */
const MIN_LINTED_FILES = 100

const program = Effect.gen(function* () {
  const { configText, config, run } = yield* lintWithoutOffs()
  const { labeled, unlabeled } = labeledDiagnostics(run.report)
  // A run that lints nothing, or a report whose diagnostics name no rule,
  // would make every "off" look unneeded.
  const failures = [
    ...[run.report.number_of_files]
      .filter((files) => files <= MIN_LINTED_FILES)
      .map((files) => `the probe run linted ${files} files\nstderr:\n${run.stderr}`),
    ...unlabeled.map(
      (diagnostic) => `a diagnostic with no file or no rule id: ${diagnostic.message}`,
    ),
    ...findUnneededOffs(".oxlintrc.json", configText, config, labeled).map(
      (finding) => `${finding.file}:${finding.line}: ${finding.message}`,
    ),
  ]
  if (failures.length === 0) return
  yield* Console.error("Lint config offs failed:")
  yield* Effect.forEach(failures, (failure) => Console.error(`  ${failure}`), { discard: true })
  return yield* Effect.fail("Lint config offs failed")
})

// The layer runs the check once as it is built; the scope closes after it.
if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(program.pipe(Effect.scoped, Effect.timeout("120 seconds"))).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
    ),
  )
