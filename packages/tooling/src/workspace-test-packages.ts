/**
 * The workspace packages `bun run test` fans out to.
 *
 * A package joins the fast suite by declaring a `test` script in its own
 * manifest, so the runner carries no list of its own. `packages/e2e`
 * declares only `test:e2e`, which keeps the slow subprocess suite out of the
 * gate. `packages/core-internal` declares no scripts at all; its `src` is a
 * symlink into core, so core's suite already covers it.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"

export interface WorkspacePackage {
  readonly name: string
  readonly cwd: string
}

const WORKSPACE_DIRECTORIES: ReadonlyArray<string> = ["packages", "apps"]

const PackageManifest = Schema.Struct({
  name: Schema.String,
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))

const declaresTestScript = (manifest: typeof PackageManifest.Type): boolean =>
  Option.fromNullishOr(manifest.scripts).pipe(
    Option.map((scripts) => Object.hasOwn(scripts, "test")),
    Option.getOrElse(() => false),
  )

/**
 * Read every `<root>/{packages,apps}/<dir>/package.json` and keep the ones
 * that declare a `test` script. `cwd` is root-relative; `packages` entries
 * come before `apps` entries, each group in name order.
 */
export const discoverTestPackages = Effect.fn("Tooling.discoverTestPackages")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found: Array<WorkspacePackage> = []

  for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
    const entries = yield* fs
      .readDirectory(path.join(root, workspaceDirectory))
      .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))
    for (const entry of [...entries].sort()) {
      const cwd = `${workspaceDirectory}/${entry}`
      const manifestPath = path.join(root, cwd, "package.json")
      const text = yield* fs.readFileString(manifestPath).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const manifest = yield* decodeManifest(text.value)
      if (!declaresTestScript(manifest)) continue
      found.push({ name: manifest.name, cwd })
    }
  }

  return found
})
