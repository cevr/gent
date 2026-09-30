import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { RpcClient, RpcTest } from "effect/rpc"
import { Headers } from "effect/http"
import { LanguageModelLayers, textStep } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/harness"
import { GentRpcs } from "../../src/server/rpc"
import { RpcHandlersLive } from "../../src/server/server"
import {
  WORKSPACE_ID_HEADER,
  provideWorkspaceIdHeader,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "../../src/server/workspace-rpc"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/domain/ids"
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
