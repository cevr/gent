import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer, Scope } from "effect"
import { createSignal } from "solid-js"
import { SessionId } from "@gent/core/extensions/api"
import herdr from "../src/extensions/builtins/herdr.client"
import {
  makeClientActivityLayer,
  type ClientActivitySnapshot,
} from "../src/extensions/client-activity"
import { makeClientLifecycleLayer } from "../src/extensions/client-services"
import { makeHerdrReporter } from "../src/extensions/herdr/reporter"
import { makeHerdrTestServer } from "./herdr-test-server-boundary"

const config = (socketPath: string) =>
  ConfigProvider.fromUnknown({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: "test:p1",
  })

describe("Herdr integration", () => {
  it.scopedLive("reports the active UI state and session changes, then releases the pane", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      const [snapshot, setSnapshot] = createSignal<ClientActivitySnapshot>({
        sessionId: SessionId.make("session-a"),
        state: "working",
      })
      const cleanups: Array<() => void> = []
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const context = yield* Layer.buildWithScope(
        Layer.mergeAll(
          makeClientActivityLayer(snapshot),
          makeClientLifecycleLayer({ addCleanup: (fn) => cleanups.push(fn) }),
        ),
        scope,
      )
      yield* herdr.setup.pipe(
        Effect.provideContext(context),
        Effect.provideService(ConfigProvider.ConfigProvider, config(server.target.socketPath)),
      )
      const first = yield* server.next
      expect(first.params).toMatchObject({
        source: "herdr:gent",
        agent: "gent",
        state: "working",
        agent_session_id: "session-a",
      })
      for (const state of [
        "blocked",
        "working",
        "idle",
      ] satisfies ClientActivitySnapshot["state"][]) {
        yield* Effect.sync(() => setSnapshot({ sessionId: SessionId.make("session-a"), state }))
        expect((yield* server.next).params.state).toBe(state)
      }
      yield* Effect.sync(() =>
        setSnapshot({ sessionId: SessionId.make("session-b"), state: "idle" }),
      )
      const switched = yield* server.next
      expect(switched.params.agent_session_id).toBe("session-b")
      expect(switched.params.seq).toBeGreaterThan(first.params.seq)
      yield* Effect.sync(() => {
        for (const cleanup of cleanups) cleanup()
      })
      yield* Scope.close(scope, Exit.void)
      const release = yield* server.next
      expect(release.method).toBe("pane.release_agent")
      expect(release.params.seq).toBeGreaterThan(switched.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("release follows an in-flight report and discards queued reports", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const reporter = yield* makeHerdrReporter(server.target).pipe(Scope.provide(scope))
      reporter.report({ state: "working" })
      const first = yield* server.next
      reporter.report({ state: "idle" })
      server.resumeReplies()
      yield* Scope.close(scope, Exit.void)
      reporter.report({ state: "working" })
      const last = yield* server.next
      expect(last.method).toBe("pane.release_agent")
      expect(last.params.seq).toBeGreaterThan(first.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("a missing socket does not fail setup or shutdown", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.stop()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
        }),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("shutdown is bounded when Herdr never replies", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
          yield* server.next
        }),
      )
      expect((yield* server.next).method).toBe("pane.release_agent")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("3 seconds")),
  )

  it.live("does nothing outside Herdr, without pane identity, or in headless mode", () =>
    Effect.gen(function* () {
      for (const env of [
        {},
        { HERDR_ENV: "1" },
        { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
        { HERDR_ENV: "0", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
      ]) {
        const result = yield* herdr.setup.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        )
        expect(result).toBeDefined()
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeClientActivityLayer(),
          makeClientLifecycleLayer({ addCleanup: () => {} }),
        ),
      ),
    ),
  )
})
