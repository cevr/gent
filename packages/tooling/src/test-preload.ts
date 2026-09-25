// @effect-diagnostics nodeBuiltinImport:off — the test preload runs in bun's test host before any Effect runtime
/**
 * Defaults every gent test suite shares. Every `test` and `test:e2e` script
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
 * - Each test file has its own default data directory. `HOME` names a temp
 *   directory made here and removed in the `afterAll` below, and
 *   `GENT_DATA_DIR` is cleared, whatever the shell set. A `--parallel` run
 *   evaluates this file again for each test file, in a fresh global scope,
 *   and runs the `afterAll` after that file's last test; a plain run
 *   evaluates it once and runs the `afterAll` after the last file. So a home
 *   is removed once, after every test that uses it. Gent's data directory
 *   defaults to `<home>/.gent`, so a test that forgets to scope one (a spill
 *   file, a log, a registry) writes under the temp home, never into the real
 *   `~/.gent`. A test that needs a specific data directory still sets its
 *   own: a home it passes, or `GENT_DATA_DIR` through its config provider or
 *   a child process's environment.
 */
import { afterAll, mock, setDefaultTimeout } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { References } from "effect"

/** Longer than every inner `Effect.timeout` a test sets without its own bun timeout. */
const TEST_TIMEOUT_BACKSTOP_MS = 30_000

setDefaultTimeout(TEST_TIMEOUT_BACKSTOP_MS)

Reflect.defineProperty(References.MinimumLogLevel, "defaultValue", {
  value: () => "None",
})

const testHome = mkdtempSync(join(tmpdir(), "gent-test-home-"))
// A child process reads HOME as it starts. This process's `homedir()` read it
// before this file ran, so the `os` module answers for it, under both names.
Bun.env["HOME"] = testHome
Reflect.deleteProperty(Bun.env, "GENT_DATA_DIR")
const osWithTestHome = { ...os, homedir: () => testHome }
for (const specifier of ["node:os", "os"]) {
  void mock.module(specifier, () => ({ ...osWithTestHome, default: osWithTestHome }))
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }))
