/**
 * Host facet survivor regression suite.
 *
 * After deleting 9 unused `ExtensionSession` CRUD methods in W33-C9.5,
 * `ctx.Session.listBranches` and the `requireCurrentAgent` helper remain as the
 * two non-trivial host-wired behaviors with no other direct test coverage.
 * The RPC suites exercise the durable mutation surface from the public
 * RPC angle; these tests pin the host-facet shape from the extension
 * angle.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { makeExtensionHostContextProvider } from "../../src/runtime/make-extension-host-context.js"
import { SqliteStorage } from "../../src/storage/sqlite-storage.js"
import { SessionStorage } from "../../src/storage/session-storage.js"
import { BranchStorage } from "../../src/storage/branch-storage.js"
import { noBranchTools } from "../../src/runtime/agent/branch-tool-feature.js"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { AgentName } from "../../src/domain/agent.js"
import {
  requireCurrentAgent,
  ExtensionContext,
  ExtensionServiceError,
} from "@gent/core/extensions/api"
import { dateFromMillis, Branch, Session } from "../../src/domain/message.js"
import { testToolContext } from "../../src/test-utils/index.js"
import { resolveExtensions } from "../../src/runtime/extensions/registry.js"
import { testHostFacts } from "../../src/test-utils"

const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const FIXTURE_DATE = dateFromMillis(0)
const EMPTY_RESOLVED_EXTENSIONS = resolveExtensions([])

describe("host facet survivors after C9.5 prune", () => {
  it.live(
    "requireCurrentAgent fails with typed ExtensionServiceError when the agent is missing",
    () =>
      Effect.gen(function* () {
        const base = testToolContext()
        const ctxLayer = Layer.succeed(
          ExtensionContext,
          ExtensionContext.of({
            ...base,
            agentName: AgentName.make("missing-agent"),
            Agent: { ...base.Agent, listAgents: Effect.succeed([]) },
          }),
        )
        const exit = yield* Effect.exit(
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          requireCurrentAgent.pipe(Effect.provide(ctxLayer)),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (!Option.isSome(error)) return
        expect(Schema.is(ExtensionServiceError)(error.value)).toBe(true)
        if (!Schema.is(ExtensionServiceError)(error.value)) return
        expect(error.value.service).toBe("ExtensionAgent")
        expect(error.value.operation).toBe("require")
        expect(error.value.message).toBe('Agent "missing-agent" not found in registry')
      }),
  )

  it.live("ctx.Session.listBranches returns branches for the current session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SESSION_ID,
          name: "test",
          cwd: "/tmp",
          createdAt: FIXTURE_DATE,
          updatedAt: FIXTURE_DATE,
        }),
      )
      yield* branches.createBranch(
        new Branch({ id: BRANCH_ID, sessionId: SESSION_ID, createdAt: FIXTURE_DATE }),
      )
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
        extensionRegistry: {
          extensionHooks: EMPTY_RESOLVED_EXTENSIONS.extensionHooks,
          getResolved: () => EMPTY_RESOLVED_EXTENSIONS,
        },
      })
      const ctx = provider.forRun({ sessionId: SESSION_ID, branchId: BRANCH_ID })
      const listed = yield* ctx.Session.listBranches
      expect(listed).toHaveLength(1)
      expect(listed[0]!.id).toBe(BRANCH_ID)
    }).pipe(
      Effect.provide(SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)),
    ),
  )
})
