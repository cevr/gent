/**
 * Defaults every gent test suite shares. Each package's `test` script
 * preloads this file, so the suites agree on them.
 *
 * - Logs are off: a test asserts on results, and a warning a test provokes on
 *   purpose is noise in the report.
 * - The per-test timeout is a backstop, not the bound. A test bounds itself
 *   with `Effect.timeout` inside the Effect, so its scope finalizers run when
 *   the bound fires; bun's own timeout abandons the fiber and skips them. With
 *   bun's 5 s default, a test that bounds itself at 8 or 20 s is cut off at
 *   5 s and its inner bound never runs. A test whose inner bound is 30 s or
 *   more passes its own, longer bun timeout.
 */
import { setDefaultTimeout } from "bun:test"
import { References } from "effect"

/** Longer than every inner `Effect.timeout` a test sets without its own bun timeout. */
const TEST_TIMEOUT_BACKSTOP_MS = 30_000

setDefaultTimeout(TEST_TIMEOUT_BACKSTOP_MS)

Reflect.defineProperty(References.MinimumLogLevel, "defaultValue", {
  value: () => "None",
})
