/**
 * The release smoke: run a built `gent` and `gent-cell` pair the way an
 * install runs it, with no Bun, no checkout and no network.
 *
 *   bun packages/e2e/src/release-smoke.ts <directory holding gent and gent-cell>
 *
 * It checks, in a scratch home that is removed after:
 *
 * - `gent --version` prints `gent v<version of apps/tui/package.json>`, and
 *   `gent --help` exits 0; the median start of `--version` is reported;
 * - a scripted turn (`--debug`, the `debug tools` scenario, whose steps run
 *   as cells) started through a link in another directory, as an install
 *   links `gent`, runs every cell with the worker beside the real executable;
 * - a user TypeScript extension loads, and one that imports a package from
 *   its own `node_modules` loads too;
 * - an extension that imports a package neither bound nor on disk is refused,
 *   and nothing is fetched;
 * - the `.env` of the working directory sets nothing.
 *
 * The release workflow runs it on each platform's runner before it packs the
 * archive; `bun run test:e2e` runs it on `apps/tui/bin`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { runProcess } from "@gent/core/extensions/api"

class SmokeError extends Schema.TaggedError<SmokeError>()("SmokeError", {
  message: Schema.String,
}) {}

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))

/** A user extension: it imports the authoring entry and `effect`, and logs what `.env` set. */
const PROBE_EXTENSION = `
import { defineExtension } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "@smoke/probe",
  setup: Effect.logInfo("smoke.probe").pipe(
    Effect.annotateLogs({ dotenv: process.env["GENT_SMOKE_DOTENV"] ?? "unset" }),
  ),
})
`

/** A directory extension that imports a package from its own node_modules. */
const LOCAL_DEPENDENCY_EXTENSION = `
import { defineExtension } from "@gent/core/extensions/api"
import { Effect } from "effect"
import { word } from "smoke-local-dependency"

export default defineExtension({
  id: "@smoke/local-dependency",
  setup: Effect.logInfo("smoke.local-dependency").pipe(Effect.annotateLogs({ word })),
})
`

/** An extension whose import nothing binds and no node_modules holds. */
const UNBOUND_EXTENSION = `
import { defineExtension } from "@gent/core/extensions/api"
import { Effect } from "effect"
import "gent-smoke-unbound-package"

export default defineExtension({ id: "@smoke/unbound", setup: Effect.void })
`

const fail = (message: string) => Effect.fail(new SmokeError({ message }))

const check = (passed: boolean, message: string) =>
  Effect.gen(function* () {
    if (!passed) return yield* fail(message)
    yield* Effect.log(`ok: ${message}`)
  })

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const smoke = Effect.fn("releaseSmoke")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const binDir = yield* fs.realPath(path.resolve(target))
  const gent = path.join(binDir, "gent")
  for (const name of ["gent", "gent-cell"]) {
    yield* check(yield* fs.exists(path.join(binDir, name)), `${name} is in ${binDir}`)
  }

  const manifest = path.resolve(
    yield* path.fromFileUrl(new URL("../../../apps/tui/package.json", import.meta.url)),
  )
  const { version } = yield* fs
    .readFileString(manifest)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageVersion)))

  const root = yield* fs.makeTempDirectoryScoped({ prefix: "gent-release-smoke-" })
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  const linkDir = path.join(root, "bin")
  const extensions = path.join(home, ".gent", "extensions")
  const dependency = path.join(
    extensions,
    "local-dependency",
    "node_modules",
    "smoke-local-dependency",
  )
  for (const dir of [work, linkDir, dependency]) yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(extensions, "probe.ts"), PROBE_EXTENSION)
  yield* fs.writeFileString(path.join(extensions, "unbound.ts"), UNBOUND_EXTENSION)
  yield* fs.writeFileString(
    path.join(extensions, "local-dependency", "index.ts"),
    LOCAL_DEPENDENCY_EXTENSION,
  )
  yield* fs.writeFileString(
    path.join(dependency, "package.json"),
    '{ "name": "smoke-local-dependency", "type": "module", "main": "index.js" }\n',
  )
  yield* fs.writeFileString(path.join(dependency, "index.js"), 'export const word = "local"\n')
  yield* fs.writeFileString(path.join(work, ".env"), "GENT_SMOKE_DOTENV=read-from-project\n")
  const link = path.join(linkDir, "gent")
  yield* fs.symlink(gent, link)

  // No Bun on PATH, no keys, and a model catalog address that refuses: the
  // scripted model needs none of them.
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GENT_DATA_DIR: path.join(root, "data"),
    GENT_AUTH_DIRECTORY: path.join(root, "auth"),
    GENT_MODEL_CATALOG_URL: "http://127.0.0.1:9",
    GENT_LOG_LEVEL: "debug",
  }
  const run = (command: string, runArgs: ReadonlyArray<string>) =>
    runProcess(command, runArgs, { cwd: work, env, extendEnv: false }).pipe(
      Effect.timeout("60 seconds"),
    )

  const versionRun = yield* run(gent, ["--version"])
  yield* check(
    versionRun.exitCode === 0 && versionRun.stdout.trim() === `gent v${version}`,
    `--version prints gent v${version} (got "${versionRun.stdout.trim()}")`,
  )
  const helpRun = yield* run(gent, ["--help"])
  yield* check(helpRun.exitCode === 0, "--help exits 0")

  const starts: Array<number> = []
  for (let i = 0; i < 9; i += 1) {
    const started = yield* Clock.currentTimeMillis
    yield* run(gent, ["--version"])
    starts.push((yield* Clock.currentTimeMillis) - started)
  }

  const turn = yield* run(link, ["--debug", "-H", "debug tools"])
  yield* check(
    turn.exitCode === 0 && turn.stderr === "",
    `the scripted turn through a link exits 0 with no stderr (exit ${turn.exitCode}: ${turn.stderr.slice(0, 400)})`,
  )
  yield* check(
    turn.stdout.includes("[tool done: cell]") && !turn.stdout.includes("[tool error: cell]"),
    "every cell ran with the worker beside the real executable",
  )

  const logDir = path.join(env.GENT_DATA_DIR, "logs")
  const logNames = (yield* fs.readDirectory(logDir)).filter((name) => name.endsWith("-server.log"))
  const logs = (yield* Effect.forEach(logNames, (name) =>
    fs.readFileString(path.join(logDir, name)),
  )).join("\n")
  const lines = logs.split("\n")
  const probeLines = lines.filter((line) => line.includes('"msg":"smoke.probe"'))
  yield* check(probeLines.length > 0, "a user TypeScript extension loads")
  yield* check(
    probeLines.every((line) => line.includes('"dotenv":"unset"')),
    "the working directory's .env sets nothing",
  )
  yield* check(
    lines.some(
      (line) => line.includes('"msg":"smoke.local-dependency"') && line.includes('"word":"local"'),
    ),
    "an extension imports a package from its own node_modules",
  )
  yield* check(
    lines.some(
      (line) => line.includes("gent-smoke-unbound-package") && line.includes("Cannot find package"),
    ),
    "an import nothing binds is refused, not fetched",
  )

  const startMs = median(starts)
  const size = (yield* fs.stat(gent)).size
  yield* Effect.log(
    `release smoke passed: gent v${version}, ${Number(size)} bytes, --version median ${startMs} ms`,
  )
})

const command = Command.make(
  "release-smoke",
  {
    directory: Argument.String("directory").pipe(
      Argument.withDescription("The directory that holds the gent and gent-cell pair"),
    ),
  },
  ({ directory }) => Effect.scoped(smoke(directory)),
)

// The layer runs the command once as it is built; the scope closes after it.
BunRuntime.runMain(
  Effect.scoped(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: "1" })).pipe(
        Layer.provide(BunServices.layer),
      ),
    ),
  ),
)
