/**
 * `makeClientRuntime` is the one runtime every client-extension surface
 * loads against. A surface gives it a transport, a workspace, and
 * `run`/`cast`; everything else defaults so headless and tests do not
 * restate no-op callbacks.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { BranchId, SessionId } from "@gent/core/protocol"
import { ClientActivity } from "../src/extensions/client-activity"
import { makeClientRuntime } from "../src/extensions/client-runtime"
import { ClientLifecycle, ClientShell, ClientWorkspace } from "../src/extensions/client-services"
import { ClientTransport } from "../src/extensions/client-transport"
import { makeClientTestTransport } from "./extension-test-harness-boundary"
import { createMockRuntime } from "./render-harness-boundary"
import { runRuntimeEffectBoundary } from "./run-effect-boundary"

const workspace = { cwd: "/tmp/client-runtime-cwd", home: "/tmp/client-runtime-home" }
const mockRuntime = createMockRuntime()
const runCast = { run: mockRuntime.run, cast: mockRuntime.cast }
const session = { sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }

describe("makeClientRuntime", () => {
  it.live("transport, workspace and run/cast alone resolve every client service", () => {
    const runtime = makeClientRuntime({
      transport: makeClientTestTransport({ currentSession: () => session }),
      workspace,
      shell: runCast,
    })
    return Effect.gen(function* () {
      const seen = yield* Effect.promise(() =>
        runRuntimeEffectBoundary(
          runtime,
          Effect.gen(function* () {
            const shell = yield* ClientShell
            const ws = yield* ClientWorkspace
            const lifecycle = yield* ClientLifecycle
            const activity = yield* ClientActivity
            const transport = yield* ClientTransport
            shell.sendMessage("ignored")
            shell.openOverlay("ignored")
            shell.closeOverlay()
            shell.switchSession({ ...session, name: "ignored" })
            lifecycle.addCleanup(() => {})
            return {
              cwd: ws.cwd,
              activity: Option.isNone(activity.snapshot),
              session: transport.currentSession(),
            }
          }),
        ),
      )
      expect(seen).toEqual({ cwd: workspace.cwd, activity: true, session })
      yield* Effect.promise(() => runtime.dispose())
    })
  })

  it.live("supplied shell, activity and lifecycle callbacks replace the no-op defaults", () => {
    const sent: Array<string> = []
    const cleanups: Array<() => void> = []
    const runtime = makeClientRuntime({
      transport: makeClientTestTransport({ currentSession: () => session }),
      workspace,
      shell: { ...runCast, sendMessage: (content) => sent.push(content) },
      activity: () => ({ state: "working" }),
      lifecycle: { addCleanup: (fn) => cleanups.push(fn) },
    })
    return Effect.gen(function* () {
      const state = yield* Effect.promise(() =>
        runRuntimeEffectBoundary(
          runtime,
          Effect.gen(function* () {
            const shell = yield* ClientShell
            const lifecycle = yield* ClientLifecycle
            const activity = yield* ClientActivity
            shell.sendMessage("hello")
            lifecycle.addCleanup(() => {})
            return Option.map(activity.snapshot, (read) => read().state)
          }),
        ),
      )
      expect(state).toEqual(Option.some("working"))
      expect(sent).toEqual(["hello"])
      expect(cleanups).toHaveLength(1)
      yield* Effect.promise(() => runtime.dispose())
    })
  })
})
