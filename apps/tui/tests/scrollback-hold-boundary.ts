/**
 * The Promise edge for a held or timed-out scrollback commit.
 *
 * `ScrollbackSurface.settle` is a Promise API that the commit awaits, so a test
 * that wants to act mid-commit has to hold that Promise open. `Deferred` drives
 * the hold; this module owns the single Effect-to-Promise edge the renderer
 * needs, which keeps the test file free of Promise control flow. The same
 * goes for the tree-sitter client's highlight, which a test stalls or fails.
 */
import { Deferred, Effect, Schema, type Scope } from "effect"
import { type CliRenderer, getTreeSitterClient, type ScrollbackSurface } from "@opentui/core"

/** The error a failed highlight rejects with. */
class HighlightFailed extends Schema.TaggedError<HighlightFailed>()("HighlightFailed", {}) {}

/**
 * For the scope, every highlight of the shared tree-sitter client never
 * answers (`stalled`: a worker that hangs) or rejects (`failing`: a worker
 * that died). The client is the one every code block draws with.
 */
export const highlightOutage = (
  kind: "stalled" | "failing",
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const client = getTreeSitterClient()
      const outage: typeof client.highlightOnce = () => {
        if (kind === "stalled") return Effect.runPromise(Effect.never)
        return Effect.runPromise(Effect.fail(new HighlightFailed()))
      }
      // The client's own highlight is a class method: the outage shadows it
      // on the instance, and removing the shadow brings it back.
      Object.defineProperty(client, "highlightOnce", { value: outage, configurable: true })
      return () => {
        Reflect.deleteProperty(client, "highlightOnce")
      }
    }),
    (restore) => Effect.sync(restore),
  ).pipe(Effect.asVoid)

interface SettleHold {
  /** Completes once the first commit waits inside `settle`. */
  readonly held: Effect.Effect<void>
  /** Lets that commit continue. */
  readonly release: Effect.Effect<void>
  /**
   * Replaces the renderer's scrollback factory with one whose first `settle`
   * waits for `release`. Every later surface is untouched, so only the commit
   * under test is held.
   */
  readonly applyTo: (renderer: CliRenderer) => void
}

export const makeSettleHold: Effect.Effect<SettleHold> = Effect.gen(function* () {
  const heldGate = yield* Deferred.make<void>()
  const releaseGate = yield* Deferred.make<void>()
  // The renderer's edge is a Promise, so the hold runs with the caller's own
  // services instead of starting a runtime beside them.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
  let firstSurface = true

  const applyTo = (renderer: CliRenderer): void => {
    const create = renderer.createScrollbackSurface.bind(renderer)
    renderer.createScrollbackSurface = (options?: Parameters<typeof create>[0]) => {
      const surface: ScrollbackSurface = create(options)
      if (!firstSurface) return surface
      firstSurface = false
      const settle = surface.settle.bind(surface)
      const heldSettle = (timeoutMs?: number): Promise<void> =>
        runPromise(
          Effect.promise(() => settle(timeoutMs)).pipe(
            Effect.andThen(Deferred.succeed(heldGate, void 0)),
            Effect.andThen(Deferred.await(releaseGate)),
          ),
        )
      // The surface's own `settle` holds; its other members stay the class's.
      return Object.defineProperty(surface, "settle", { value: heldSettle })
    }
  }

  return {
    held: Deferred.await(heldGate),
    release: Deferred.succeed(releaseGate, void 0).pipe(Effect.asVoid),
    applyTo,
  }
})

/** The error a timed-out `settle` rejects with, as OpenTUI's own timeout does. */
class SettleTimeout extends Schema.TaggedError<SettleTimeout>()("SettleTimeout", {}) {}

interface SettleTimeouts {
  /** How many `settle` calls the renderer's surfaces made so far. */
  readonly calls: () => number
  /**
   * Replaces the renderer's scrollback factory with one whose surfaces time
   * out at once on their first `failures` settles, before any highlight can
   * land: a cold tree-sitter worker, a loaded machine, a worker that died.
   * Every later settle is the surface's own.
   */
  readonly applyTo: (renderer: CliRenderer) => void
}

export const makeSettleTimeouts = (failures: number): SettleTimeouts => {
  let calls = 0
  const applyTo = (renderer: CliRenderer): void => {
    const create = renderer.createScrollbackSurface.bind(renderer)
    renderer.createScrollbackSurface = (options?: Parameters<typeof create>[0]) => {
      const surface: ScrollbackSurface = create(options)
      const settle = surface.settle.bind(surface)
      const timedSettle = (timeoutMs?: number): Promise<void> => {
        calls += 1
        if (calls <= failures) return Effect.runPromise(Effect.fail(new SettleTimeout()))
        return settle(timeoutMs)
      }
      return Object.defineProperty(surface, "settle", { value: timedSettle })
    }
  }
  return { calls: () => calls, applyTo }
}

/** The error a refused write throws, as OpenTUI's own geometry check does. */
class CommitRefused extends Schema.TaggedError<CommitRefused>()("CommitRefused", {}) {}

/**
 * Replaces the renderer's scrollback factory with one whose surfaces refuse
 * their first `refusals` writes, as scrollback refuses rows drawn for a
 * screen that has since changed. Every later write is the surface's own.
 */
export const refuseCommits =
  (refusals: number) =>
  (renderer: CliRenderer): void => {
    let calls = 0
    const create = renderer.createScrollbackSurface.bind(renderer)
    renderer.createScrollbackSurface = (options?: Parameters<typeof create>[0]) => {
      const surface: ScrollbackSurface = create(options)
      const commitRows = surface.commitRows.bind(surface)
      const refusingCommit: typeof commitRows = (...rows) => {
        calls += 1
        if (calls <= refusals) return Effect.runSync(Effect.fail(new CommitRefused()))
        return commitRows(...rows)
      }
      return Object.defineProperty(surface, "commitRows", { value: refusingCommit })
    }
  }
