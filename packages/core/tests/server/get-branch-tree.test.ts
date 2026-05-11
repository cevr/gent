/**
 * Regression suite for the `getBranchTree` pure helper.
 *
 * The helper replaces the old `SessionQueries.getBranchTree` plumbed
 * method (W35-C4). Pin its public contract — composition over
 * `BranchStorage.listBranches` + `BranchStorage.countMessagesByBranches`
 * + pure `buildBranchTree`, and propagation of a delegated failure as
 * `StorageError` — so future refactors cannot silently re-introduce a
 * service method or skip the typed-error surface.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { Branch, dateFromMillis } from "../../src/domain/message.js"
import { StorageError } from "../../src/domain/storage-error.js"
import { BranchStorage } from "../../src/storage/branch-storage.js"
import { getBranchTree, buildBranchTree } from "../../src/server/session-utils.js"

const SESSION_ID = SessionId.make("test-session")
const ROOT_ID = BranchId.make("branch-root")
const CHILD_ID = BranchId.make("branch-child")
const ORPHAN_ID = BranchId.make("branch-orphan")

const makeBranch = (id: BranchId, parentBranchId: BranchId | undefined, createdMs: number) =>
  new Branch({
    id,
    sessionId: SESSION_ID,
    parentBranchId,
    parentMessageId: undefined,
    name: undefined,
    summary: undefined,
    createdAt: dateFromMillis(createdMs),
  })

const die = (label: string) => (): Effect.Effect<never, StorageError, never> =>
  Effect.die(`${label} not wired in test`)

const branchStorageLayer = (
  branches: ReadonlyArray<Branch>,
  counts: ReadonlyMap<BranchId, number>,
) =>
  Layer.succeed(BranchStorage, {
    createBranch: die("createBranch"),
    getBranch: die("getBranch"),
    listBranches: () => Effect.succeed(branches),
    deleteBranch: die("deleteBranch"),
    updateBranchSummary: die("updateBranchSummary"),
    countMessages: die("countMessages"),
    countMessagesByBranches: () => Effect.succeed(counts),
  })

describe("getBranchTree helper", () => {
  it.live("composes listBranches + countMessagesByBranches via buildBranchTree", () =>
    Effect.gen(function* () {
      const branches = [
        makeBranch(ROOT_ID, undefined, 0),
        makeBranch(CHILD_ID, ROOT_ID, 100),
        makeBranch(ORPHAN_ID, undefined, 50),
      ]
      const counts = new Map<BranchId, number>([
        [ROOT_ID, 3],
        [CHILD_ID, 7],
        [ORPHAN_ID, 1],
      ])
      const tree = yield* getBranchTree(SESSION_ID).pipe(
        Effect.provide(branchStorageLayer(branches, counts)),
      )
      // Assert exact equality against the pure builder. A regression
      // that drops listBranches' or countMessagesByBranches' values
      // (e.g. passing [] or an empty map) would fail this equality.
      expect(tree).toEqual(buildBranchTree(branches, counts))
      // Sanity check the shape so the equality target is non-trivial.
      expect(tree).toHaveLength(2)
      const root = tree.find((node) => node.branch.id === ROOT_ID)
      expect(root?.messageCount).toBe(3)
      expect(root?.children).toHaveLength(1)
      expect(root?.children[0]?.branch.id).toBe(CHILD_ID)
      expect(root?.children[0]?.messageCount).toBe(7)
    }),
  )

  it.live("propagates listBranches failures as StorageError", () =>
    Effect.gen(function* () {
      const failure = new StorageError({ message: "boom" })
      const layer = Layer.succeed(BranchStorage, {
        createBranch: die("createBranch"),
        getBranch: die("getBranch"),
        listBranches: () => Effect.fail(failure),
        deleteBranch: die("deleteBranch"),
        updateBranchSummary: die("updateBranchSummary"),
        countMessages: die("countMessages"),
        countMessagesByBranches: () => Effect.succeed(new Map<BranchId, number>()),
      })
      const exit = yield* Effect.exit(getBranchTree(SESSION_ID).pipe(Effect.provide(layer)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(StorageError)(error.value)).toBe(true)
    }),
  )

  it.live("propagates countMessagesByBranches failures as StorageError", () =>
    Effect.gen(function* () {
      const failure = new StorageError({ message: "count boom" })
      const layer = Layer.succeed(BranchStorage, {
        createBranch: die("createBranch"),
        getBranch: die("getBranch"),
        listBranches: () => Effect.succeed([makeBranch(ROOT_ID, undefined, 0)]),
        deleteBranch: die("deleteBranch"),
        updateBranchSummary: die("updateBranchSummary"),
        countMessages: die("countMessages"),
        countMessagesByBranches: () => Effect.fail(failure),
      })
      const exit = yield* Effect.exit(getBranchTree(SESSION_ID).pipe(Effect.provide(layer)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(Schema.is(StorageError)(error.value)).toBe(true)
    }),
  )
})
