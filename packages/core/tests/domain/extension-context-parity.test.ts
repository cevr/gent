/**
 * Type-level parity test: ExtensionContext must mirror ExtensionHostContext keys.
 *
 * If ExtensionHostContext gains a new facet or method that ExtensionContext
 * doesn't have, this file will fail to compile.
 */

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import {
  type ExtensionAsyncContext,
  toExtensionAsyncContext,
} from "@gent/core/domain/extension-context"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

// ── Type-level assertions ──
// These types will cause a compile error if the two interfaces diverge.

// Assert ExtensionContext has all top-level keys of ExtensionHostContext
type AssertTopLevelKeys<
  _T extends Record<keyof ExtensionHostContext, unknown> = ExtensionAsyncContext,
> = true

// Assert each facet has the same method keys
type AssertExtensionKeys<
  _T extends Record<keyof ExtensionHostContext.Extension, unknown> =
    ExtensionAsyncContext.Extension,
> = true

type AssertAgentKeys<
  _T extends Record<keyof ExtensionHostContext.Agent, unknown> = ExtensionAsyncContext.Agent,
> = true

type AssertSessionKeys<
  _T extends Record<keyof ExtensionHostContext.SessionFacet, unknown> =
    ExtensionAsyncContext.SessionFacet,
> = true

type AssertInteractionKeys<
  _T extends Record<keyof ExtensionHostContext.Interaction, unknown> =
    ExtensionAsyncContext.Interaction,
> = true

type AssertTurnKeys<
  _T extends Record<keyof ExtensionHostContext.Turn, unknown> = ExtensionAsyncContext.Turn,
> = true

// Prove the type aliases are used (prevents "unused" warnings)
const _typeCheck: [
  AssertTopLevelKeys,
  AssertExtensionKeys,
  AssertAgentKeys,
  AssertSessionKeys,
  AssertInteractionKeys,
  AssertTurnKeys,
] = [true, true, true, true, true, true]
void _typeCheck

// ── Runtime assertions ──

describe("ExtensionContext parity", () => {
  test("toExtensionContext produces Promise-returning methods for all facets", () => {
    const stubHost = {
      sessionId: "s" as SessionId,
      branchId: "b" as BranchId,
      cwd: "/tmp",
      home: "/tmp",
      extension: {
        send: () => Effect.void,
        ask: () => Effect.void,
        getUiSnapshots: () => Effect.succeed([]),
        getUiSnapshot: () => Effect.succeed(undefined),
      },
      agent: {
        get: () => Effect.succeed(undefined),
        require: () => Effect.die("stub"),
        run: () => Effect.die("stub"),
        resolveDualModelPair: () => Effect.die("stub"),
      },
      session: {
        listMessages: () => Effect.succeed([]),
        getSession: () => Effect.succeed(undefined),
        getDetail: () => Effect.die("stub"),
        renameCurrent: () => Effect.succeed({ renamed: false }),
        estimateContextPercent: () => Effect.succeed(0),
        search: () => Effect.succeed([]),
        listBranches: () => Effect.succeed([]),
        createBranch: () => Effect.succeed({ branchId: "b" }),
        forkBranch: () => Effect.succeed({ branchId: "b" }),
        switchBranch: () => Effect.void,
        createChildSession: () => Effect.succeed({ sessionId: "s", branchId: "b" }),
        getChildSessions: () => Effect.succeed([]),
        deleteSession: () => Effect.void,
        deleteBranch: () => Effect.void,
        deleteMessages: () => Effect.void,
      },
      interaction: {
        approve: () => Effect.die("stub"),
        present: () => Effect.die("stub"),
        confirm: () => Effect.die("stub"),
        review: () => Effect.die("stub"),
      },
      turn: {
        queueFollowUp: () => Effect.void,
        interject: () => Effect.void,
      },
    } as ExtensionHostContext

    const ctx = toExtensionAsyncContext(stubHost)

    // Scalar props
    expect(ctx.sessionId).toBe("s")
    expect(ctx.branchId).toBe("b")
    expect(ctx.cwd).toBe("/tmp")
    expect(ctx.home).toBe("/tmp")

    // Every facet method returns a Promise
    expect(ctx.extension.send({} as never)).toBeInstanceOf(Promise)
    expect(ctx.extension.getUiSnapshots()).toBeInstanceOf(Promise)
    expect(ctx.extension.getUiSnapshot("x")).toBeInstanceOf(Promise)
    expect(ctx.agent.get("x" as never)).toBeInstanceOf(Promise)
    expect(ctx.session.listMessages()).toBeInstanceOf(Promise)
    expect(ctx.session.getSession()).toBeInstanceOf(Promise)
    expect(ctx.session.renameCurrent("x")).toBeInstanceOf(Promise)
    expect(ctx.session.estimateContextPercent()).toBeInstanceOf(Promise)
    expect(ctx.session.search("x")).toBeInstanceOf(Promise)
    expect(ctx.session.listBranches()).toBeInstanceOf(Promise)
    expect(ctx.session.createBranch({})).toBeInstanceOf(Promise)
    expect(ctx.session.forkBranch({ atMessageId: "m" as never })).toBeInstanceOf(Promise)
    expect(ctx.session.switchBranch({ toBranchId: "b" as never })).toBeInstanceOf(Promise)
    expect(ctx.session.createChildSession({})).toBeInstanceOf(Promise)
    expect(ctx.session.getChildSessions()).toBeInstanceOf(Promise)
    expect(ctx.session.deleteSession("s" as never)).toBeInstanceOf(Promise)
    expect(ctx.session.deleteBranch("b" as never)).toBeInstanceOf(Promise)
    expect(ctx.session.deleteMessages({})).toBeInstanceOf(Promise)
    expect(ctx.turn.queueFollowUp({ content: "x" })).toBeInstanceOf(Promise)
    expect(ctx.turn.interject({ content: "x" })).toBeInstanceOf(Promise)
  })
})
