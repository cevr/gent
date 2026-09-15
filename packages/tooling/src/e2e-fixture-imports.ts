/**
 * Guard: every e2e test file drives a subprocess.
 *
 * `packages/e2e` holds the tests that need process isolation: a PTY-hosted
 * TUI or a spawned `gent` server. A test file there that imports neither
 * fixture runs in-process inside the slow suite, and belongs in the owning
 * package's `tests/` directory instead.
 */
export interface E2eFixtureImportFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const E2E_TEST_FILE = /^packages\/e2e\/tests\/.*\.test\.ts$/

/** An `import` whose module path is one of the two subprocess fixtures. */
const FIXTURE_IMPORT =
  /^[ \t]*import\b[^"']*["']\.\.\/src\/(?:server-process-fixture|pty-fixture)(?:\.js)?["']/m

export const findE2eFixtureImportFindings = (
  file: string,
  text: string,
): ReadonlyArray<E2eFixtureImportFinding> => {
  if (!E2E_TEST_FILE.test(file)) return []
  if (FIXTURE_IMPORT.test(text)) return []
  return [
    {
      file,
      line: 1,
      message:
        "e2e test files must import ../src/server-process-fixture or ../src/pty-fixture; an in-process test belongs in the owning package's tests/",
    },
  ]
}
