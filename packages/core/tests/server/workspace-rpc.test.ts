import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option } from "effect"
import { RpcClient, RpcTest } from "effect/rpc"
import { Headers } from "effect/http"
import { textStep } from "../../src/runtime/provider"
import { createE2ELayer, LanguageModelLayers, waitFor } from "../../src/test-utils/harness"
import { ExtensionStatusScope, GentRpcs } from "../../src/server/rpc"
import { SteerCommand } from "../../src/domain/message"
import { RpcHandlersLive } from "../../src/server/server"
import {
  WORKSPACE_ID_HEADER,
  provideWorkspaceIdHeader,
  sessionNamedBy,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "../../src/server/workspace-rpc"
import { BranchId, CurrentWorkspaceId, SessionId, WorkspaceId } from "../../src/domain/ids"
import { e2ePreset } from "../helpers/test-preset"

const validWorkspaceId = WorkspaceId.make("a".repeat(64))
const otherWorkspaceId = WorkspaceId.make("b".repeat(64))

describe("workspace RPC middleware", () => {
  it.live("publishes a valid workspace id to request scope and rejects a malformed one", () =>
    Effect.gen(function* () {
      const observe = (workspaceId: string) =>
        Effect.service(CurrentWorkspaceId).pipe(
          provideWorkspaceIdHeader(Headers.fromInput({ [WORKSPACE_ID_HEADER]: workspaceId })),
        )
      expect(yield* observe(validWorkspaceId)).toBe(validWorkspaceId)
      const invalid = yield* Effect.exit(observe("not-a-workspace"))
      expect(invalid._tag).toBe("Failure")
    }),
  )

  it.live("rejects raw RPC calls without workspace header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const context = yield* Layer.build(
          Layer.provide(RpcHandlersLive, createE2ELayer({ ...e2ePreset, providerLayer })),
        )
        const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
        const exit = yield* Effect.exit(client["session.list"]())
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Bun.inspect(exit.cause)).toContain("WorkspaceHeaderError")
        }
      }),
    ),
  )

  it.live("isolates session lists by workspace header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const context = yield* Layer.build(
          Layer.provide(RpcHandlersLive, createE2ELayer({ ...e2ePreset, providerLayer })),
        )
        const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
        const inWorkspace = <A, E, R>(workspaceId: string, effect: Effect.Effect<A, E, R>) =>
          RpcClient.withHeaders(effect, { [WORKSPACE_ID_HEADER]: workspaceId })

        yield* inWorkspace(
          validWorkspaceId,
          client["session.create"]({ name: "workspace-a-session", cwd: "/nonexistent/a" }),
        )
        yield* inWorkspace(
          otherWorkspaceId,
          client["session.create"]({ name: "workspace-b-session", cwd: "/nonexistent/b" }),
        )

        const first = yield* inWorkspace(validWorkspaceId, client["session.list"]())
        const second = yield* inWorkspace(otherWorkspaceId, client["session.list"]())

        expect(first.map((session) => session.name)).toEqual(["workspace-a-session"])
        expect(second.map((session) => session.name)).toEqual(["workspace-b-session"])
      }),
    ),
  )

  it.live("reads the session a payload names, in each shape the contract uses", () =>
    Effect.sync(() => {
      const sessionId = SessionId.make("named-session")
      const branchId = BranchId.make("named-branch")
      expect(sessionNamedBy({ payload: { sessionId, branchId } })).toEqual(Option.some(sessionId))
      const command = SteerCommand.cases.Cancel.make({ sessionId, branchId, requestId: "r-1" })
      expect(sessionNamedBy({ payload: { command } })).toEqual(Option.some(sessionId))
      const scope = ExtensionStatusScope.cases.Session.make({ id: sessionId })
      expect(sessionNamedBy({ payload: { scope } })).toEqual(Option.some(sessionId))
      // Server-scoped calls name no session: the header's workspace stands.
      // oxlint-disable-next-line effect/preferTaggedConstructors -- the raw payload this test reads; `Launch` has no tag default on purpose (`ExtensionStatusScope`)
      expect(sessionNamedBy({ payload: { scope: { _tag: "Launch" } } })).toEqual(Option.none())
      expect(sessionNamedBy({ payload: { parentSessionId: sessionId } })).toEqual(Option.none())
      expect(sessionNamedBy({ payload: {} })).toEqual(Option.none())
    }),
  )

  it.live("runs a call that names a session in the session's workspace, whatever the header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const context = yield* Layer.build(
          Layer.provide(RpcHandlersLive, createE2ELayer({ ...e2ePreset, providerLayer })),
        )
        const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
        const inWorkspace = <A, E, R>(workspaceId: string, effect: Effect.Effect<A, E, R>) =>
          RpcClient.withHeaders(effect, { [WORKSPACE_ID_HEADER]: workspaceId })

        const created = yield* inWorkspace(
          validWorkspaceId,
          client["session.create"]({ name: "workspace-a-session", cwd: "/nonexistent/a" }),
        )
        const target = { sessionId: created.sessionId, branchId: created.branchId }
        // A steer command names its session inside the command.
        const command = SteerCommand.cases.Interject.make({
          ...target,
          requestId: "steer-from-b",
          message: "steer from b",
        })
        yield* inWorkspace(otherWorkspaceId, client["steer.command"]({ command }))
        const queued = yield* waitFor(
          inWorkspace(validWorkspaceId, client["queue.get"](target)),
          (snapshot) => snapshot.steering.length === 1,
          2_000,
          "the steer from the other workspace",
        )
        expect(queued.steering.map((entry) => entry.content)).toEqual(["steer from b"])
        // A status scope names its session as `id`.
        const status = yield* inWorkspace(
          otherWorkspaceId,
          client["extension.listStatus"]({
            scope: ExtensionStatusScope.cases.Session.make({ id: created.sessionId }),
          }),
        )
        expect(status).toEqual(
          yield* inWorkspace(
            validWorkspaceId,
            client["extension.listStatus"]({
              scope: ExtensionStatusScope.cases.Session.make({ id: created.sessionId }),
            }),
          ),
        )
        // The list stays the header's: B lists none of A's sessions.
        expect(yield* inWorkspace(otherWorkspaceId, client["session.list"]())).toEqual([])
        // An id that names no stored session keeps the header's workspace.
        const missing = yield* inWorkspace(
          otherWorkspaceId,
          client["session.get"]({ sessionId: SessionId.make("no-such-session") }),
        )
        expect(missing).toBeNull()
      }),
    ),
  )

  /**
   * A client hashes its cwd into the header; the server hashes its launch cwd
   * into the id it reads sessions under. The two run in different processes.
   * If they ever disagree, every request silently lands in an empty
   * workspace — so pin the derivation here.
   */
  it.live("derives a valid, canonical, stable workspace id", () =>
    Effect.gen(function* () {
      const id = workspaceIdForCwd("/tmp/gent")

      // The header the client sends passes the RPC middleware as that id.
      const published = yield* Effect.service(CurrentWorkspaceId).pipe(
        provideWorkspaceIdHeader(Headers.fromInput(workspaceHeadersForCwd("/tmp/gent"))),
      )
      expect(published).toBe(id)

      // Canonical: the path is resolved before hashing.
      expect(workspaceIdForCwd("/tmp/gent/../gent")).toBe(id)
      expect(workspaceIdForCwd("/tmp/gent/")).toBe(id)

      // Distinct directories never collide.
      expect(workspaceIdForCwd("/tmp/other")).not.toBe(id)

      // The header carries exactly that id.
      expect(workspaceHeadersForCwd("/tmp/gent")[WORKSPACE_ID_HEADER]).toBe(String(id))
    }),
  )
})
