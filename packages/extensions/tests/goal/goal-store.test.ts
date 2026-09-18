/**
 * Goal state lives in one file per branch. Writes replace the file atomically
 * and status changes pull the continuation that is still waiting in the queue.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, FileSystem, Option, PlatformError, Ref, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { ExtensionServiceError, makeFileWriter } from "@gent/core-internal/domain/extension"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { testExtensionFiles } from "@gent/core-internal/test-utils/extension-host-context"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"
import { goalContinuationSource, GoalSnapshot, GoalTool } from "../../src/goal.js"

describe("goal store", () => {
  it.scopedLive("completing a goal pulls its queued continuation and leaves one clean file", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-")
      const dequeued = yield* Ref.make<ReadonlyArray<string>>([])
      const branchId = BranchId.make("goal-branch")
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        Session: {
          ...testToolContext().Session,
          dequeueFollowUp: ({ sourceId }) =>
            Ref.update(dequeued, (all) => [...all, sourceId]).pipe(Effect.as(true)),
        },
        State: { changed: () => Effect.void },
      })
      const created = yield* runToolWithCtx(
        GoalTool,
        { action: "create", objective: "Write the pelican poem" },
        ctx,
      )
      expect(created.goal?.status).toBe("active")
      const completed = yield* runToolWithCtx(GoalTool, { action: "complete" }, ctx)
      expect(completed.goal?.status).toBe("complete")
      // Completion removes the continuation queued for the active state.
      expect(yield* Ref.get(dequeued)).toEqual([
        goalContinuationSource({ ...created.goal!, status: "active" }),
      ])
      // Only the final snapshot remains; staging files are renamed away.
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readDirectory(`${home}/.gent/goals`)).toEqual([`${branchId}.json`])
      const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(GoalSnapshot))(
        yield* fs.readFileString(`${home}/.gent/goals/${branchId}.json`),
      )
      expect(Option.fromUndefinedOr(snapshot.goal?.status)).toEqual(Option.some("complete"))
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("a write the disk rejects mid-flight leaves no staging file behind", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-enospc-")
      const branchId = BranchId.make("goal-branch")
      const fs = yield* FileSystem.FileSystem
      // The disk fills after the entry is created: the write creates the file, then reports ENOSPC.
      const filling: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path) =>
          fs.writeFileString(path, "").pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: path,
                  description: "ENOSPC: no space left on device",
                }),
              ),
            ),
          ),
      }
      const files = testExtensionFiles()
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        Files: {
          ...files,
          write: (path, content, options) =>
            makeFileWriter(filling, files.dirname)(path, content, options).pipe(
              Effect.mapError(
                (cause) =>
                  new ExtensionServiceError({
                    service: "ExtensionFiles",
                    operation: "write",
                    message: cause.message,
                    cause,
                  }),
              ),
            ),
        },
        State: { changed: () => Effect.void },
      })
      const created = yield* runToolWithCtx(
        GoalTool,
        { action: "create", objective: "Write the pelican poem" },
        ctx,
      ).pipe(Effect.exit)
      expect(Exit.isFailure(created)).toBe(true)
      // The failed write leaves nothing: no target, no staging sibling.
      expect(yield* fs.readDirectory(`${home}/.gent/goals`)).toEqual([])
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})
