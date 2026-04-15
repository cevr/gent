import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { ArtifactId, BranchId, SessionId } from "@gent/core/domain/ids"
import type { Artifact } from "@gent/core/extensions/artifacts-protocol"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { SessionStarted } from "@gent/core/domain/event"
import { ARTIFACTS_EXTENSION_ID, ArtifactProtocol } from "@gent/core/extensions/artifacts-protocol"

const sessionId = SessionId.of("art-test-session")
const branchId = BranchId.of("art-test-branch")

const withRuntime = (
  fn: (
    runtime: typeof ExtensionStateRuntime.Type,
  ) => Effect.Effect<void, unknown, ExtensionStateRuntime>,
) =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
    const e2eLayer = createE2ELayer({ providerLayer })

    yield* Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
      yield* fn(runtime)
    }).pipe(Effect.provide(e2eLayer))
  })

describe("Artifacts extension", () => {
  it.live("Save creates an artifact and returns it", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const result = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Auth migration plan",
            sourceTool: "plan",
            content: "## Step 1\nDo the thing",
            branchId,
          }),
          branchId,
        )
        expect(result.label).toBe("Auth migration plan")
        expect(result.sourceTool).toBe("plan")
        expect(result.content).toBe("## Step 1\nDo the thing")
        expect(result.status).toBe("active")
        expect(result.branchId).toBe(branchId)
        expect(result.id).toBeDefined()
      }),
    ),
  )

  it.live("Save upserts by sourceTool + branchId", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const first = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Plan v1",
            sourceTool: "plan",
            content: "original",
            branchId,
          }),
          branchId,
        )
        const second = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Plan v2",
            sourceTool: "plan",
            content: "updated",
            branchId,
          }),
          branchId,
        )
        // Same ID — upserted, not duplicated
        expect(second.id).toBe(first.id)
        expect(second.label).toBe("Plan v2")
        expect(second.content).toBe("updated")

        // List should have only 1 item
        const list = yield* runtime.ask(sessionId, ArtifactProtocol.List({ branchId }), branchId)
        expect(list.length).toBe(1)
      }),
    ),
  )

  it.live("different sourceTools create separate artifacts", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Plan",
            sourceTool: "plan",
            content: "plan content",
            branchId,
          }),
          branchId,
        )
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Audit",
            sourceTool: "audit",
            content: "audit content",
            branchId,
          }),
          branchId,
        )
        const list = yield* runtime.ask(sessionId, ArtifactProtocol.List({ branchId }), branchId)
        expect(list.length).toBe(2)
      }),
    ),
  )

  it.live("Read by id returns the artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const saved = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "Test", sourceTool: "test", content: "hello", branchId }),
          branchId,
        )
        const read = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Read({ query: { _tag: "ById" as const, id: saved.id } }),
          branchId,
        )
        expect(read).not.toBeNull()
        expect((read as Artifact).content).toBe("hello")
      }),
    ),
  )

  it.live("Read by sourceTool returns the artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Test",
            sourceTool: "review",
            content: "findings",
            branchId,
          }),
          branchId,
        )
        const read = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Read({
            query: { _tag: "BySource" as const, sourceTool: "review", branchId },
          }),
          branchId,
        )
        expect(read).not.toBeNull()
        expect((read as Artifact).content).toBe("findings")
      }),
    ),
  )

  it.live("Read by sourceTool falls back to session-wide artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        // Save a session-wide artifact (no branchId)
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "Global plan", sourceTool: "plan", content: "global" }),
          branchId,
        )
        // Read from a specific branch — should fall back to the session-wide one
        const read = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Read({
            query: { _tag: "BySource" as const, sourceTool: "plan", branchId },
          }),
          branchId,
        )
        expect(read).not.toBeNull()
        expect((read as Artifact).content).toBe("global")
      }),
    ),
  )

  it.live("Read returns null for missing artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const read = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Read({
            query: { _tag: "ById" as const, id: ArtifactId.of("nonexistent") },
          }),
          branchId,
        )
        expect(read).toBeNull()
      }),
    ),
  )

  it.live("Update patches content", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const saved = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Plan",
            sourceTool: "plan",
            content: "- [ ] step 1\n- [ ] step 2",
            branchId,
          }),
          branchId,
        )
        const updated = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Update({
            id: saved.id,
            patch: { find: "- [ ] step 1", replace: "- [x] step 1" },
          }),
          branchId,
        )
        expect(updated).not.toBeNull()
        expect((updated as Artifact).content).toBe("- [x] step 1\n- [ ] step 2")
      }),
    ),
  )

  it.live("Update with replaceAll patches all occurrences", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const saved = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Plan",
            sourceTool: "plan",
            content: "TODO: a\nTODO: b\nTODO: c",
            branchId,
          }),
          branchId,
        )
        const updated = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Update({
            id: saved.id,
            patch: { find: "TODO", replace: "DONE", replaceAll: true },
          }),
          branchId,
        )
        expect(updated).not.toBeNull()
        expect((updated as Artifact).content).toBe("DONE: a\nDONE: b\nDONE: c")
      }),
    ),
  )

  it.live("Update changes status", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const saved = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "Plan", sourceTool: "plan", content: "done", branchId }),
          branchId,
        )
        const updated = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Update({ id: saved.id, status: "resolved" }),
          branchId,
        )
        expect((updated as Artifact).status).toBe("resolved")
      }),
    ),
  )

  it.live("Update returns null for missing artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const result = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Update({ id: ArtifactId.of("nonexistent") }),
          branchId,
        )
        expect(result).toBeNull()
      }),
    ),
  )

  it.live("Clear removes an artifact", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const saved = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "Temp", sourceTool: "test", content: "x", branchId }),
          branchId,
        )
        yield* runtime.ask(sessionId, ArtifactProtocol.Clear({ id: saved.id }), branchId)
        const list = yield* runtime.ask(sessionId, ArtifactProtocol.List({ branchId }), branchId)
        expect(list.length).toBe(0)
      }),
    ),
  )

  it.live("List filters by branchId", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const otherBranch = BranchId.of("other-branch")
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "A", sourceTool: "plan", content: "a", branchId }),
          branchId,
        )
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "B",
            sourceTool: "plan",
            content: "b",
            branchId: otherBranch,
          }),
          branchId,
        )
        // Session-wide artifact (no branchId)
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({ label: "C", sourceTool: "audit", content: "c" }),
          branchId,
        )

        const filtered = yield* runtime.ask(
          sessionId,
          ArtifactProtocol.List({ branchId }),
          branchId,
        )
        // Should include A (matches branch) and C (session-wide), but not B (different branch)
        expect(filtered.length).toBe(2)
        expect(filtered.map((a: Artifact) => a.label).sort()).toEqual(["A", "C"])
      }),
    ),
  )

  it.live("prompt projection includes active artifacts for current branch", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Auth plan",
            sourceTool: "plan",
            content: "plan content",
            branchId,
          }),
          branchId,
        )
        yield* runtime.ask(
          sessionId,
          ArtifactProtocol.Save({
            label: "Audit results",
            sourceTool: "audit",
            content: "findings",
            branchId,
          }),
          branchId,
        )

        const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
        const artSnapshot = snapshots.find((s) => s.extensionId === ARTIFACTS_EXTENSION_ID)
        expect(artSnapshot).toBeDefined()
        const model = (artSnapshot as NonNullable<typeof artSnapshot>).model as {
          items: readonly { label: string }[]
        }
        expect(model.items.length).toBe(2)
        expect(model.items.map((i) => i.label).sort()).toEqual(["Audit results", "Auth plan"])
      }),
    ),
  )
})
