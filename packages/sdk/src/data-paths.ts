/**
 * The one owner of where gent keeps its durable state on disk.
 *
 * `GENT_DATA_DIR` names the directory holding `data.db`; without it the
 * directory is `<home>/.gent`. Every reader — the server that writes the
 * database, and the `doctor` and `storage reset` commands that inspect and
 * archive it — resolves through here, so an operator who redirects the
 * database does not get tools that look somewhere else.
 */

import { Config, Effect, Option } from "effect"
// @effect-diagnostics nodeBuiltinImport:off — this module owns path resolution for gent's data directory
// oxlint-disable-next-line effect/noNodeBuiltinImport -- pure path arithmetic the TUI calls before a Path layer is wired
import { resolve as pathResolve, join as pathJoin } from "node:path"

/** A malformed value is no value: the fallback under `home` still applies. */
const optionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()))

const DB_FILE = "data.db"

/** The database file plus the sidecars SQLite writes beside it. */
interface DataPaths {
  readonly dataDir: string
  readonly dbPath: string
  /** `dbPath` and its `-shm`/`-wal` sidecars, in that order. */
  readonly files: ReadonlyArray<string>
  /** Where `storage reset` moves the files it clears. */
  readonly archiveDir: string
}

/**
 * Build the paths for an already-resolved data directory. Pure — callers that
 * hold an explicit directory (a test fixture, an explicit `dbPath`) use this;
 * callers reading the environment use {@link dataPaths}.
 */
export const dataPathsIn = (dataDir: string): DataPaths => {
  const resolvedDir = pathResolve(dataDir)
  const dbPath = pathJoin(resolvedDir, DB_FILE)
  return {
    dataDir: resolvedDir,
    dbPath,
    files: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`],
    archiveDir: pathJoin(resolvedDir, "storage-archive"),
  }
}

/** The data directory `GENT_DATA_DIR` names, else `<home>/.gent`. */
const resolveDataDir = (home: string): Effect.Effect<string> =>
  Effect.map(optionalEnv("GENT_DATA_DIR"), (dataDir) =>
    pathResolve(Option.getOrElse(dataDir, () => pathJoin(home, ".gent"))),
  )

/**
 * Resolve the paths from the environment. `home` names the fallback root; a
 * caller without one passes `HOME`.
 */
export const dataPaths = (home: string): Effect.Effect<DataPaths> =>
  Effect.map(resolveDataDir(home), dataPathsIn)
