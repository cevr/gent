import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { buildExtensionHealthSnapshot } from "@gent/core/server/extension-health"
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
      status: "degraded",
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
        status: "degraded",
        activation: {
          status: "failed",
          phase: "startup",
          error: "startup boom",
        },
        scheduler: {
          status: "healthy",
          failures: [],
        },
      },
      {
        manifest: { id: "@gent/plan" },
        scope: "builtin",
        sourcePath: "builtin",
        status: "degraded",
        activation: {
          status: "active",
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
          status: "degraded",
          failures: [{ jobId: "reflect", error: "launchd boom" }],
        },
      },
    ])
  })

  test("transport decodes legacy actor status and encodes tagged actors to legacy wire shape", () => {
    const legacy = {
      extensions: [
        {
          manifest: { id: "@gent/plan" },
          scope: "builtin",
          sourcePath: "builtin",
          status: "degraded",
          activation: { status: "active" },
          actor: {
            extensionId: "@gent/plan",
            sessionId: "s1",
            branchId: "b1",
            status: "failed",
            error: "actor boom",
            failurePhase: "runtime",
          },
          scheduler: {
            status: "healthy",
            failures: [],
          },
        },
      ],
      summary: {
        status: "degraded",
        failedExtensions: [],
        failedActors: ["@gent/plan"],
        failedScheduledJobs: [],
      },
    }

    const decoded = Schema.decodeUnknownSync(ExtensionHealthSnapshot)(legacy)
    expect(decoded.extensions[0]?.actor).toEqual({
      _tag: "failed",
      extensionId: "@gent/plan",
      sessionId: "s1",
      branchId: "b1",
      error: "actor boom",
      failurePhase: "runtime",
    })

    const encoded = Schema.encodeSync(ExtensionHealthSnapshot)(decoded)
    expect(encoded.extensions[0]?.actor).toEqual({
      extensionId: "@gent/plan",
      sessionId: "s1",
      branchId: "b1",
      status: "failed",
      error: "actor boom",
      failurePhase: "runtime",
    })
  })
})
