/**
 * A server stand-in for crash tests: it opens the background bash resource
 * over the SQLite file BG_STORAGE_PATH, starts BG_COMMAND as a background job
 * with the data directory under BG_HOME, and waits. The test ends this
 * process with SIGKILL, so no finalizer runs, as when a server crashes.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer } from "effect"
import { BunSqlite, BunPlatformLive } from "@gent/core/host-bun"
import { runToolWithCtx, SqliteStorage, testToolContext } from "@gent/core/test-utils"
import { ToolCallId } from "@gent/core/protocol"
import { BackgroundBashLayer, BashTool } from "../../src/exec-tools.js"

BunRuntime.runMain(
  Effect.gen(function* () {
    const storagePath = yield* Config.String("BG_STORAGE_PATH")
    const home = yield* Config.String("BG_HOME")
    const command = yield* Config.String("BG_COMMAND")
    const storage = SqliteStorage.WithSql(BunSqlite.file(storagePath)).pipe(
      Layer.provide(BunPlatformLive),
    )
    const ctx = testToolContext({
      toolCallId: ToolCallId.make("crashed-host-job"),
      cwd: home,
      home,
    })
    return yield* runToolWithCtx(BashTool, { command, run_in_background: true }, ctx).pipe(
      Effect.andThen(Effect.never),
      Effect.provide(
        BackgroundBashLayer.pipe(Layer.provideMerge(Layer.merge(storage, BunPlatformLive))),
      ),
    )
  }),
)
