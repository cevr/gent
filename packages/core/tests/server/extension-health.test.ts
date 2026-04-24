import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { buildExtensionHealthSnapshot } from "../../src/server/extension-health"
import { ExtensionHealthSnapshot } from "@gent/core/server/transport-contract"

describe("buildExtensionHealthSnapshot", () => {
  test("merges activation, actor, and scheduler failures into one server-owned summary", () => {
    const snapshot = buildExtensionHealthSnapshot(
      [
        {
          manifest: { id: "@gent/memory" },
          scope: "builtin",
          sourcePath: "builtin",
          status: "failed",
          phase: "startup",
          error: "startup boom",
        },
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          status: "active",
          scheduledJobFailures: [{ jobId: "reflect", error: "launchd boom" }],
        },
      ],
      [
        {
          _tag: "failed",
          extensionId: "@gent/plan",
          sessionId: "s1" as never,
          branchId: "b1" as never,
          error: "actor boom",
          failurePhase: "runtime",
        },
      ],
    )

    expect(snapshot.summary).toEqual({
      _tag: "degraded",
      subtitle: "extension activation degraded",
      failedExtensions: ["@gent/memory"],
      failedActors: ["@gent/plan"],
      failedScheduledJobs: ["@gent/plan:reflect"],
    })
    expect(snapshot.extensions).toEqual([
      {
        manifest: { id: "@gent/memory" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "degraded",
        activation: {
          _tag: "failed",
          phase: "startup",
          error: "startup boom",
        },
        scheduler: {
          _tag: "healthy",
        },
      },
      {
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        _tag: "degraded",
        activation: {
          _tag: "active",
        },
        actor: {
          _tag: "failed",
          extensionId: "@gent/plan",
          sessionId: "s1",
          branchId: "b1",
          error: "actor boom",
          failurePhase: "runtime",
        },
        scheduler: {
          _tag: "degraded",
          failures: [{ jobId: "reflect", error: "launchd boom" }],
        },
      },
    ])
  })

  test("transport uses tagged extension health states", () => {
    const wire = {
      extensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          _tag: "degraded",
          activation: { _tag: "active" },
          actor: {
            _tag: "failed",
            extensionId: "@gent/plan",
            sessionId: "s1",
            branchId: "b1",
            error: "actor boom",
            failurePhase: "runtime",
          },
          scheduler: {
            _tag: "healthy",
          },
        },
      ],
      summary: {
        _tag: "degraded",
        failedExtensions: [],
        failedActors: ["@gent/plan"],
        failedScheduledJobs: [],
      },
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(wire)
    expect(decoded.extensions[0]?.actor).toEqual({
      _tag: "failed",
      extensionId: "@gent/plan",
      sessionId: "s1",
      branchId: "b1",
      error: "actor boom",
      failurePhase: "runtime",
    })

    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)
    expect(encoded.extensions[0]).toMatchObject({
      _tag: "degraded",
      activation: { _tag: "active" },
      actor: {
        _tag: "failed",
        extensionId: "@gent/plan",
        sessionId: "s1",
        branchId: "b1",
        error: "actor boom",
        failurePhase: "runtime",
      },
      scheduler: { _tag: "healthy" },
    })
  })

  test("transport rejects contradictory health state bags", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExtensionHealthSnapshot)({
        extensions: [
          {
            manifest: { id: "@gent/memory" },
            scope: "builtin",
            sourcePath: "builtin",
            _tag: "healthy",
            activation: {
              _tag: "active",
              error: "should not fit active state",
            },
            scheduler: {
              _tag: "degraded",
              failures: [],
            },
          },
        ],
        summary: { _tag: "healthy", failedExtensions: ["@gent/memory"] },
      }),
    ).toThrow()
  })
})
