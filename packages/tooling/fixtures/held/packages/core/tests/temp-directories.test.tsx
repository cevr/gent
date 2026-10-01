// @ts-nocheck — held-shapes fixture
// Retired: the guards `findRepoTempDirectories` and `findSharedTestHomes`
// (packages/tooling/src/guards.ts), with oxlint-plugin-effect 0.25. A test's
// temp directory lives in the system temp directory, and its home, data and
// working directory are its own.
import { mkdtemp, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, FileSystem, Path } from "effect"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"

export const repoTemp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const under = yield* fs.makeTempDirectoryScoped({ directory: path.resolve(import.meta.dir, "../.."), prefix: "gent-x-" }) // held-by: effect/noRepoTempDirectory
  const packageRoot = path.resolve(import.meta.dir, "../../..")
  const bound = yield* fs.makeTempDirectoryScoped({ directory: packageRoot, prefix: "x-" }) // held-by: effect/noRepoTempDirectory
  const fixture = mkdtempSync(join(__dirname, "fixture-")) // held-by: effect/noRepoTempDirectory
  const relativeJoin = mkdtempSync(path.join("packages/core/tests", "case-")) // held-by: effect/noRepoTempDirectory
  const resolved = yield* fs.makeTempDirectory({ directory: resolve("./apps/tui") }) // held-by: effect/noRepoTempDirectory
  const cwdTemp = mkdtempSync(join(process.cwd(), "tmp-")) // held-by: effect/noRepoTempDirectory
  const cwdDirectory = yield* fs.makeTempDirectoryScoped({ directory: process.cwd() }) // held-by: effect/noRepoTempDirectory
  const resolvedOut = yield* fs.makeTempDirectoryScoped({ directory: path.resolve("out") }) // held-by: effect/noRepoTempDirectory
  const relativeDirectory = yield* fs.makeTempDirectoryScoped({ directory: "./scratch" }) // held-by: effect/noRepoTempDirectory
  const relativePrefix = mkdtempSync("case-") // held-by: effect/noRepoTempDirectory
  mkdtemp("case-", () => {}) // held-by: effect/noRepoTempDirectory
  const here = process.cwd()
  const boundCwd = mkdtempSync(join(here, "case-")) // held-by: effect/noRepoTempDirectory
  const dotTmp = join(import.meta.dir, ".tmp") // held-by: effect/noRepoTempDirectory
  const tmpSegment = join(__dirname, "tmp", "case") // held-by: effect/noRepoTempDirectory
  const tempFixtures = path.resolve(import.meta.dirname, "../temp-fixtures") // held-by: effect/noRepoTempDirectory
  const extensionTmp = join(import.meta.dir, "../../.tmp-ext-integration") // held-by: effect/noRepoTempDirectory
  return [under, bound, fixture, relativeJoin, resolved, cwdTemp, cwdDirectory, resolvedOut, relativeDirectory, relativePrefix, boundCwd, dotTmp, tmpSegment, tempFixtures, extensionTmp]
})

declare const WorkspaceProvider: (props: { cwd: string; home: string }) => unknown
declare const RuntimeEnvironment: { Live: (input: object) => unknown }
declare const client: { session: { create: (input: object) => unknown } }
declare const loadClientExtensions: (input: object) => unknown
declare const logDirFor: (input: object) => unknown
declare const overrides: { home?: string } | undefined
declare const cwd: string

export const sharedHomes = () => [
  <WorkspaceProvider cwd={cwd} home="/tmp" />, // held-by: effect/noSharedTestHome
  { cwd: "/tmp" }, // held-by: effect/noSharedTestHome
  { home: "/tmp" }, // held-by: effect/noSharedTestHome
  RuntimeEnvironment.Live({ home: "/tmp/test-home" }), // held-by: effect/noSharedTestHome
  logDirFor({ GENT_DATA_DIR: "/var/tmp/gent-scratch" }), // held-by: effect/noSharedTestHome
  (home: string = "/private/tmp") => home, // held-by: effect/noSharedTestHome
  { home: overrides?.home ?? "/tmp" }, // held-by: effect/noSharedTestHome
  { homeDirectory: Effect.succeed("/dev/shm/x") }, // held-by: effect/noSharedTestHome
  { home: tmpdir() }, // held-by: effect/noSharedTestHome
  client.session.create({ cwd: "/tmp" }), // held-by: effect/noSharedTestHome
  loadClientExtensions({ userDir: "/tmp/user" }), // held-by: effect/noSharedTestHome
  loadClientExtensions({ projectDir: "/tmp/project" }), // held-by: effect/noSharedTestHome
  { sessionCwd: "/tmp" }, // held-by: effect/noSharedTestHome
  { cwd: tmpdir() }, // held-by: effect/noSharedTestHome
  { home: `${tmpdir()}/case` }, // held-by: effect/noSharedTestHome
  { home: join(tmpdir(), "case") }, // held-by: effect/noSharedTestHome
  { home: join("/tmp", "case") }, // held-by: effect/noSharedTestHome
  makeTempDirectoryScoped,
]

export const alphaCwd = "/tmp/gent-alpha-profile" // held-by: effect/noSharedTestHome
process.env.HOME = "/tmp" // held-by: effect/noSharedTestHome
