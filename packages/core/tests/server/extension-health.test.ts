import { describe, expect, test } from "bun:test"
import { buildExtensionHealthSnapshot } from "@gent/core/server/extension-health"

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
          extensionId: "@gent/plan",
          sessionId: "s1" as never,
          branchId: "b1" as never,
          status: "failed",
          error: "actor boom",
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
          extensionId: "@gent/plan",
          sessionId: "s1",
          branchId: "b1",
          status: "failed",
          error: "actor boom",
        },
        scheduler: {
          status: "degraded",
          failures: [{ jobId: "reflect", error: "launchd boom" }],
        },
      },
    ])
  })
})
