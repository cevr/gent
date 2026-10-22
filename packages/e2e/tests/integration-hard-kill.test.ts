/**
 * The integration gate across a hard kill. A real host process
 * (`src/machine-host.ts`) pushes through `integration.push` with fake `gh`
 * and `git` executables first on its `PATH`, over a fake remote in files.
 * The fake push moves the remote head, then never answers; the test ends the
 * host with SIGKILL there, between the gate's first write and the push's
 * answer. A second host over the same files, with no client call, must
 * reconcile the gate from the remote head through the gate's own wake
 * record, clear it from the fake CI, and push nothing. The second host's
 * only model calls are the one that closes the killed turn (its push result
 * is recorded as interrupted; the tool does not run again) and the turn the
 * gate's green message wakes.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { runProcess } from "@gent/core/extensions/api"
import { BunSqlite } from "@gent/core/host-bun"
import { makeTempDirectoryScoped, waitFor } from "@gent/core/test-utils"
import { hardKill, hostPrinted, spawnTestHost } from "../src/server-process-fixture"

const BASE = "a".repeat(40)
const CANDIDATE = "b".repeat(40)

// ── the fake remote ─────────────────────────────────────────────────────────

/**
 * `gh`: signed in; the head of `main` from `remote/head`; `test` required;
 * the check runs from `remote/runs.json` for any commit. A list answers
 * as `--paginate --slurp` does: one array of its one page.
 */
const ghScript = (remote: string) => `#!/bin/sh
case "$1" in
  auth) echo "Logged in to github.com"; exit 0 ;;
  api) ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
case "$2" in
  repos/cevr/gent/git/ref/heads/main) printf '{"object":{"sha":"%s"}}' "$(cat '${remote}/head')" ;;
  repos/cevr/gent/branches/main/protection/required_status_checks) echo '{"contexts":["test"],"checks":[]}' ;;
  repos/cevr/gent/rules/branches/main) echo '[]' ;;
  repos/cevr/gent/commits/*/check-runs*) printf '['; cat '${remote}/runs.json'; printf ']' ;;
  repos/cevr/gent/commits/*/status*) printf '[{"sha":"%s","statuses":[]}]' "$(echo "$2" | cut -d/ -f5)" ;;
  *) echo "HTTP 404: $2" >&2; exit 1 ;;
esac
`

/**
 * `git`: the GitHub remote, HEAD at the candidate, every head an ancestor.
 * A push records its commit and moves the remote head, then names its pid
 * and never answers. Any other verb runs the real git.
 */
const gitScript = (remote: string, realGit: string) => `#!/bin/sh
case "$1" in
  remote) echo "git@github.com:cevr/gent.git" ;;
  rev-parse) echo "${CANDIDATE}" ;;
  merge-base) exit 0 ;;
  push)
    sha="\${3%%:*}"
    echo "$sha" >> '${remote}/pushes.log'
    echo "$sha" > '${remote}/head'
    echo $$ > '${remote}/push.pid'
    exec sleep 600 ;;
  *) exec '${realGit}' "$@" ;;
esac
`

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const lines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return []
    const text = yield* fs.readFileString(file)
    return text.split("\n").filter((line) => line.length > 0)
  })

/** Ends the fake push that outlived its host; one already gone is fine. */
const reapPush = (remote: string) =>
  lines(`${remote}/push.pid`).pipe(
    Effect.flatMap((read) =>
      Effect.forEach(read.map(Number).filter(Number.isInteger), (pid) =>
        Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore),
      ),
    ),
    Effect.ignore,
  )

/** A fixture directory with the fake remote and its executables on `bin/`. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* makeTempDirectoryScoped("gent-integration-kill-")
  const remote = `${dir}/remote`
  yield* Effect.addFinalizer(() => reapPush(remote))
  const which = yield* runProcess("/usr/bin/which", ["git"])
  const realGit = which.stdout.trim()
  expect(realGit.length).toBeGreaterThan(0)
  yield* fs.makeDirectory(remote)
  yield* fs.makeDirectory(`${dir}/bin`)
  yield* fs.writeFileString(`${remote}/head`, `${BASE}\n`)
  yield* fs.writeFileString(`${remote}/runs.json`, encodeJson({ check_runs: [] }))
  yield* fs.writeFileString(`${dir}/bin/gh`, ghScript(remote))
  yield* fs.writeFileString(`${dir}/bin/git`, gitScript(remote, realGit))
  yield* fs.chmod(`${dir}/bin/gh`, 0o755)
  yield* fs.chmod(`${dir}/bin/git`, 0o755)
  const path = yield* Config.String("PATH")
  return { dir, remote, path: `${dir}/bin:${path}` }
})

// ── the host process ────────────────────────────────────────────────────────

const spawnHost = (
  dir: string,
  path: string,
  label: string,
  env: Readonly<Record<string, string>> = {},
) =>
  spawnTestHost({
    script: "src/machine-host.ts",
    prefix: "MH",
    dir,
    label,
    env: { MH_HOME: dir, MH_CWD: dir, PATH: path, ...env },
  })

// ── reading the database ────────────────────────────────────────────────────

const databaseOf = (dir: string) =>
  Layer.build(BunSqlite.file(`${dir}/gent.db`).pipe(Layer.provide(BunServices.layer)))

const GateRow = Schema.Struct({ state: Schema.String, generation: Schema.Finite })
const decodeGateRows = Schema.decodeUnknownSync(Schema.Array(GateRow))

/** The gate on `cevr/gent:main`, its state and generation. */
const gateOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT json_extract(record_json, '$.state._tag') AS state,
      json_extract(record_json, '$.generation') AS generation
    FROM integration_gates WHERE repo = 'cevr/gent' AND ref = 'main'`
  return Option.fromUndefinedOr(decodeGateRows(rows)[0])
})

const ToldDetails = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  generation: Schema.Finite,
  state: Schema.String,
})
const ResultRow = Schema.Struct({ part: Schema.String })
const decodeResultRows = Schema.decodeUnknownSync(Schema.Array(ResultRow))

/** The recorded results of the `push` call. */
const pushResults = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT part_json AS part FROM content_chunks
    WHERE json_extract(part_json, '$.type') = 'tool-result' AND json_extract(part_json, '$.id') = 'push'`
  return decodeResultRows(rows).map((row) => row.part)
})

const ToldRow = Schema.Struct({ details: Schema.fromJsonString(ToldDetails) })
const decodeToldRows = Schema.decodeUnknownSync(Schema.Array(ToldRow))

/** The gate's messages to its host, their details. */
const toldOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT json_extract(metadata, '$.details') AS details
    FROM messages WHERE json_extract(metadata, '$.customType') = 'integration'`
  return decodeToldRows(rows).map((row) => row.details)
})

/** The gate's wake record comes due now: the poll time passed while no host ran. */
const gateDueNow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE branch_wakes SET at = 0, version = version + 1
    WHERE extension_id = '@gent/integration' AND source_id LIKE 'integration:%'`
  const rows = yield* sql`SELECT source_id FROM branch_wakes
    WHERE extension_id = '@gent/integration' AND at = 0`
  return rows.length
})

// ── the tests ───────────────────────────────────────────────────────────────

describe("the integration gate across a hard kill", () => {
  it.live(
    "a push killed before its answer reconciles from the remote head and clears from CI with no client call",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, remote, path } = yield* fixture
        const database = yield* databaseOf(dir)
        const sql = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.provideContext(statement, database)

        // The first host pushes; the fake remote takes the commit and never answers.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, path, "first", { MH_PUSH: "main" })
            yield* hostPrinted(first, "push sent", 20_000)
            yield* waitFor(fs.exists(`${remote}/push.pid`), (held) => held, 20_000, "the push ran")
            const held = yield* sql(gateOf)
            expect(Option.map(held, (gate) => gate.state)).toEqual(Option.some("Integrating"))
            yield* hardKill(first.proc)
          }),
        )
        yield* reapPush(remote)
        expect(yield* lines(`${remote}/pushes.log`)).toEqual([CANDIDATE])
        expect((yield* lines(`${remote}/head`))[0]).toBe(CANDIDATE)
        const askedBefore = (yield* lines(`${dir}/requests.log`)).length

        // CI went green while no host ran, and the gate's poll time passed.
        yield* fs.writeFileString(
          `${remote}/runs.json`,
          encodeJson({
            check_runs: [
              {
                id: 1,
                name: "test",
                head_sha: CANDIDATE,
                status: "completed",
                conclusion: "success",
              },
            ],
          }),
        )
        expect(yield* sql(gateDueNow)).toBe(1)

        // The second host makes no client call: the gate's own record wakes it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* spawnHost(dir, path, "second")
            const cleared = yield* waitFor(
              sql(gateOf),
              (gate) => Option.isSome(gate) && gate.value.state === "Clear",
              30_000,
              "the gate cleared",
            )
            expect(Option.map(cleared, (gate) => gate.generation)).toEqual(Option.some(1))
            const told = yield* waitFor(sql(toldOf), (rows) => rows.length > 0, 20_000, "a tell")
            expect(told).toEqual([
              { repo: "cevr/gent", ref: "main", generation: 1, state: "Clear" },
            ])
          }),
        )
        // One push across both hosts: the reconcile pushed nothing.
        expect(yield* lines(`${remote}/pushes.log`)).toEqual([CANDIDATE])
        // The gate's record fired at the start and settled it in that fire.
        // The loop-open repair can arm the record again while that fire
        // runs; the one more fire it makes finds the gate told and ends.
        const wakes = (yield* lines(`${dir}/wakes.log`)).filter((line) =>
          line.includes(" integration:"),
        )
        expect(wakes[0]).toMatch(/^start integration:[0-9a-f]{64} Done$/)
        for (const line of wakes.slice(1)) {
          expect(line).toMatch(/^due integration:[0-9a-f]{64} Done$/)
        }
        expect(wakes.length).toBeLessThanOrEqual(2)
        // The killed push did not run again: its result is the interruption.
        const results = yield* sql(pushResults)
        expect(results).toHaveLength(1)
        expect(results[0]).toContain('"reason":"Interrupted"')
        // The second host asked the model only to close the killed turn and to answer the gate.
        const asked = (yield* lines(`${dir}/requests.log`)).slice(askedBefore)
        for (const line of asked) {
          expect(
            line.startsWith("CALL integration.push push") ||
              line.startsWith("Integration gate cevr/gent:main is green"),
          ).toBe(true)
        }
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )
})
