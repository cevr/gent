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
 *   more passes its own, longer bun timeout. `setDefaultTimeout` below holds
 *   for each file of a `--parallel` run and for a one-file run; a plain
 *   multi-file run applies it to its first file only, so a plain lane also
 *   passes `--timeout=30000`, and the guards check that it does.
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
 * - No test reaches the network. A `fetch` to a host other than this machine
 *   is refused, and the test it ran under fails. A test that needs a remote
 *   answer gives one: a fixture HTTP client, or a seeded catalog (the
 *   models.dev catalog a driver's `listModels` reads, which a cold home
 *   would otherwise fetch). Requests to `localhost`, `127.0.0.1` and `::1`
 *   pass: a test server runs there.
 */
import { afterAll, afterEach, expect, mock, setDefaultTimeout } from "bun:test"
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
// oxlint-disable-next-line effect/noGlobals -- the preload sets the test process's environment before any Effect runtime
Bun.env["HOME"] = testHome
// oxlint-disable-next-line effect/noGlobals -- the preload sets the test process's environment before any Effect runtime
Reflect.deleteProperty(Bun.env, "GENT_DATA_DIR")
const osWithTestHome = { ...os, homedir: () => testHome }
for (const specifier of ["node:os", "os"]) {
  void mock.module(specifier, () => ({ ...osWithTestHome, default: osWithTestHome }))
}
afterAll(() => rmSync(testHome, { recursive: true, force: true }))

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])
/** The remote URLs the running test tried to fetch. */
const refusedFetches: Array<string> = []
const passedFetch = globalThis.fetch
const guardedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(new Request(input).url)
  // oxlint-disable-next-line effect/noGlobals -- the guard is fetch: a loopback request goes on to the real one
  if (LOOPBACK_HOSTS.has(url.hostname)) return passedFetch(input, init)
  refusedFetches.push(url.href)
  // oxlint-disable-next-line effect/noNewPromise, effect/noNewError -- fetch's own failure shape: a rejected promise with an Error
  return Promise.reject(new Error(`the test preload refuses a network fetch: ${url.href}`))
}
globalThis.fetch = Object.assign(guardedFetch, { preconnect: passedFetch.preconnect })
afterEach(() => {
  expect(refusedFetches.splice(0)).toEqual([])
})
