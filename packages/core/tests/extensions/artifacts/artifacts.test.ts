import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { ref } from "@gent/core/extensions/api"
import { ArtifactId, BranchId, type SessionId } from "@gent/core/domain/ids"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { createRpcHarness } from "@gent/core/test-utils/rpc-harness"
import { ArtifactsExtension } from "@gent/extensions/artifacts"
import { ArtifactRpc, type Artifact } from "@gent/extensions/artifacts-protocol"
import { setupExtension } from "../../../src/runtime/extensions/loader"
import { e2ePreset } from "../helpers/test-preset.js"

const forgedBranchId = BranchId.make("art-test-branch")

const setupArtifactsExt = Effect.provide(
  setupExtension(
    { extension: ArtifactsExtension, scope: "builtin", sourcePath: "builtin" },
    "/test/cwd",
    "/test/home",
  ),
  BunServices.layer,
)

const SaveRef = ref(ArtifactRpc.Save)
const ReadRef = ref(ArtifactRpc.Read)
const UpdateRef = ref(ArtifactRpc.Update)
const ClearRef = ref(ArtifactRpc.Clear)
const ListRef = ref(ArtifactRpc.List)

type ArtifactCapabilityRef =
  | typeof SaveRef
  | typeof ReadRef
  | typeof UpdateRef
  | typeof ClearRef
  | typeof ListRef

const withArtifactsClient = <A>(
  fn: (ctx: {
    readonly branchId: BranchId
    readonly request: (
      capability: ArtifactCapabilityRef,
      input: unknown,
    ) => Effect.Effect<unknown, unknown>
    readonly requestAtBranch: (
      branchId: BranchId,
      capability: ArtifactCapabilityRef,
      input: unknown,
    ) => Effect.Effect<unknown, unknown>
    readonly requestInSession: (
      sessionId: SessionId,
      branchId: BranchId,
      capability: ArtifactCapabilityRef,
      input: unknown,
    ) => Effect.Effect<unknown, unknown>
    readonly createBranch: (name: string) => Effect.Effect<BranchId, unknown>
    readonly createSession: () => Effect.Effect<
      { readonly sessionId: SessionId; readonly branchId: BranchId },
      unknown
    >
  }) => Effect.Effect<A, unknown>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ext = yield* setupArtifactsExt
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
      const {
        client,
        sessionId,
        branchId: transportBranchId,
      } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensions: [ext],
      })
      return yield* fn({
        branchId: transportBranchId,
        request: (capability, input) =>
          client.extension.request({
            sessionId,
            branchId: transportBranchId,
            extensionId: capability.extensionId,
            capabilityId: capability.capabilityId,
            intent: capability.intent,
            input,
          }) as Effect.Effect<unknown, unknown>,
        requestAtBranch: (branchId, capability, input) =>
          client.extension.request({
            sessionId,
            branchId,
            extensionId: capability.extensionId,
            capabilityId: capability.capabilityId,
            intent: capability.intent,
            input,
          }) as Effect.Effect<unknown, unknown>,
        requestInSession: (sessionId, branchId, capability, input) =>
          client.extension.request({
            sessionId,
            branchId,
            extensionId: capability.extensionId,
            capabilityId: capability.capabilityId,
            intent: capability.intent,
            input,
          }) as Effect.Effect<unknown, unknown>,
        createBranch: (name) =>
          client.branch.create({ sessionId, name }).pipe(Effect.map((result) => result.branchId)),
        createSession: () => client.session.create({ cwd: "/tmp" }),
      })
    }).pipe(Effect.timeout("4 seconds")),
  )

describe("Artifacts extension", () => {
  it.live("Save creates an artifact and returns it", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const result = (yield* request(SaveRef, {
          label: "Auth migration plan",
          sourceTool: "plan",
          content: "## Step 1\nDo the thing",
          branchId: forgedBranchId,
        })) as Artifact
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
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const first = (yield* request(SaveRef, {
          label: "Plan v1",
          sourceTool: "plan",
          content: "original",
          branchId,
        })) as Artifact
        const second = (yield* request(SaveRef, {
          label: "Plan v2",
          sourceTool: "plan",
          content: "updated",
          branchId,
        })) as Artifact
        expect(second.id).toBe(first.id)
        expect(second.label).toBe("Plan v2")
        expect(second.content).toBe("updated")

        const list = (yield* request(ListRef, { branchId })) as ReadonlyArray<Artifact>
        expect(list).toHaveLength(1)
      }),
    ),
  )

  it.live("different sourceTools create separate artifacts", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        yield* request(SaveRef, {
          label: "Plan",
          sourceTool: "plan",
          content: "plan content",
          branchId,
        })
        yield* request(SaveRef, {
          label: "Audit",
          sourceTool: "audit",
          content: "audit content",
          branchId,
        })
        const list = (yield* request(ListRef, { branchId })) as ReadonlyArray<Artifact>
        expect(list).toHaveLength(2)
      }),
    ),
  )

  it.live("Read by id returns the artifact", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const saved = (yield* request(SaveRef, {
          label: "Test",
          sourceTool: "test",
          content: "hello",
          branchId,
        })) as Artifact
        const read = (yield* request(ReadRef, {
          query: { _tag: "ById" as const, id: saved.id },
        })) as Artifact | null
        expect(read).not.toBeNull()
        expect(read?.content).toBe("hello")
      }),
    ),
  )

  it.live("Read by sourceTool returns the artifact", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        yield* request(SaveRef, {
          label: "Test",
          sourceTool: "review",
          content: "findings",
          branchId,
        })
        const read = (yield* request(ReadRef, {
          query: { _tag: "BySource" as const, sourceTool: "review", branchId },
        })) as Artifact | null
        expect(read).not.toBeNull()
        expect(read?.content).toBe("findings")
      }),
    ),
  )

  it.live("Read by sourceTool uses the validated transport branch", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        yield* request(SaveRef, {
          label: "Branch plan",
          sourceTool: "plan",
          content: "branch",
          branchId: forgedBranchId,
        })
        const read = (yield* request(ReadRef, {
          query: { _tag: "BySource" as const, sourceTool: "plan", branchId: forgedBranchId },
        })) as Artifact | null
        expect(read).not.toBeNull()
        expect(read?.branchId).toBe(branchId)
        expect(read?.content).toBe("branch")
      }),
    ),
  )

  it.live("Read returns null for missing artifact", () =>
    withArtifactsClient(({ request }) =>
      Effect.gen(function* () {
        const read = yield* request(ReadRef, {
          query: { _tag: "ById" as const, id: ArtifactId.make("nonexistent") },
        })
        expect(read).toBeNull()
      }),
    ),
  )

  it.live("Update patches content", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const saved = (yield* request(SaveRef, {
          label: "Plan",
          sourceTool: "plan",
          content: "- [ ] step 1\n- [ ] step 2",
          branchId,
        })) as Artifact
        const updated = (yield* request(UpdateRef, {
          id: saved.id,
          patch: { find: "- [ ] step 1", replace: "- [x] step 1" },
        })) as Artifact | null
        expect(updated?.content).toBe("- [x] step 1\n- [ ] step 2")
      }),
    ),
  )

  it.live("Update with replaceAll patches all occurrences", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const saved = (yield* request(SaveRef, {
          label: "Plan",
          sourceTool: "plan",
          content: "TODO: a\nTODO: b\nTODO: c",
          branchId,
        })) as Artifact
        const updated = (yield* request(UpdateRef, {
          id: saved.id,
          patch: { find: "TODO", replace: "DONE", replaceAll: true },
        })) as Artifact | null
        expect(updated?.content).toBe("DONE: a\nDONE: b\nDONE: c")
      }),
    ),
  )

  it.live("Update changes status", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const saved = (yield* request(SaveRef, {
          label: "Plan",
          sourceTool: "plan",
          content: "done",
          branchId,
        })) as Artifact
        const updated = (yield* request(UpdateRef, {
          id: saved.id,
          status: "resolved" as const,
        })) as Artifact | null
        expect(updated?.status).toBe("resolved")
      }),
    ),
  )

  it.live("Update returns null for missing artifact", () =>
    withArtifactsClient(({ request }) =>
      Effect.gen(function* () {
        const result = yield* request(UpdateRef, { id: ArtifactId.make("nonexistent") })
        expect(result).toBeNull()
      }),
    ),
  )

  it.live("Clear removes an artifact", () =>
    withArtifactsClient(({ request, branchId }) =>
      Effect.gen(function* () {
        const saved = (yield* request(SaveRef, {
          label: "Temp",
          sourceTool: "test",
          content: "x",
          branchId,
        })) as Artifact
        yield* request(ClearRef, { id: saved.id })
        const list = (yield* request(ListRef, { branchId })) as ReadonlyArray<Artifact>
        expect(list).toHaveLength(0)
      }),
    ),
  )

  it.live("List filters by validated transport branch", () =>
    withArtifactsClient(({ request, requestAtBranch, createBranch, branchId }) =>
      Effect.gen(function* () {
        const otherBranch = yield* createBranch("other")
        yield* request(SaveRef, { label: "A", sourceTool: "plan", content: "a", branchId })
        yield* requestAtBranch(otherBranch, SaveRef, {
          label: "B",
          sourceTool: "plan",
          content: "b",
          branchId,
        })
        yield* request(SaveRef, { label: "C", sourceTool: "audit", content: "c" })

        const filtered = (yield* request(ListRef, {
          branchId: otherBranch,
        })) as ReadonlyArray<Artifact>
        expect(filtered).toHaveLength(2)
        expect(filtered.map((artifact) => artifact.label).sort()).toEqual(["A", "C"])

        const otherFiltered = (yield* requestAtBranch(otherBranch, ListRef, {
          branchId,
        })) as ReadonlyArray<Artifact>
        expect(otherFiltered).toHaveLength(1)
        expect(otherFiltered[0]?.label).toBe("B")
      }),
    ),
  )

  it.live("artifacts are isolated by session", () =>
    withArtifactsClient(({ request, requestInSession, createSession }) =>
      Effect.gen(function* () {
        const second = yield* createSession()
        yield* request(SaveRef, {
          label: "First session",
          sourceTool: "plan",
          content: "first",
        })
        yield* requestInSession(second.sessionId, second.branchId, SaveRef, {
          label: "Second session",
          sourceTool: "plan",
          content: "second",
        })

        const firstList = (yield* request(ListRef, {})) as ReadonlyArray<Artifact>
        const secondList = (yield* requestInSession(
          second.sessionId,
          second.branchId,
          ListRef,
          {},
        )) as ReadonlyArray<Artifact>
        expect(firstList.map((artifact) => artifact.label)).toEqual(["First session"])
        expect(secondList.map((artifact) => artifact.label)).toEqual(["Second session"])
      }),
    ),
  )
})
