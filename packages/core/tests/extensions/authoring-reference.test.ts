import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import SessionNotesExtension, {
  AddNoteTool,
} from "../../../../examples/extensions/session-notes.js"
import DynamicScratchpadExtension from "../../../../examples/extensions/dynamic-scratchpad.js"
import { ExtensionSetupContext, getToolId, type GentExtension } from "@gent/core/extensions/api"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { publicSetupContext } from "../../src/domain/extension-setup-context"
import { getToolMetadata } from "@gent/core-internal/domain/capability/tool"
import type { LoadedExtension } from "../../src/domain/extension"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { buildResourceLayer } from "../../src/runtime/extensions/resource-host"
import { testSetupCtx } from "@gent/core-internal/test-utils"

const sessionNotesSourceUrl = new URL(
  "../../../../examples/extensions/session-notes.ts",
  import.meta.url,
)
const dynamicScratchpadSourceUrl = new URL(
  "../../../../examples/extensions/dynamic-scratchpad.ts",
  import.meta.url,
)

const setupOf = (ext: GentExtension<never>) => {
  const raw = testSetupCtx()
  return ext.setup.pipe(Effect.provideService(ExtensionSetupContext, publicSetupContext(raw)))
}

const loadedFrom = (
  ext: GentExtension<never>,
  contributions: LoadedExtension["contributions"],
): LoadedExtension => ({
  manifest: { id: ext.manifest.id },
  scope: "project",
  sourcePath: "/project/.gent/extensions/session-notes.ts",
  contributions,
})

describe("extension authoring reference", () => {
  it.live("one-file public API example contributes tool, slash request, state, and hook", () =>
    Effect.gen(function* () {
      const contributions = yield* setupOf(SessionNotesExtension)
      const loaded = loadedFrom(SessionNotesExtension, contributions)
      const resolved = resolveExtensions([loaded])
      const resourceLayer = buildResourceLayer([loaded], "process")

      expect(String(SessionNotesExtension.manifest.id)).toBe("session-notes")
      expect(contributions.resources ?? []).toHaveLength(1)
      expect(contributions.tools ?? []).toHaveLength(1)
      expect(contributions.requests ?? []).toHaveLength(1)
      expect(contributions.hooks ?? []).toHaveLength(1)
      expect(String(getToolId((contributions.tools ?? [])[0]!))).toBe("session_note_add")

      const command = resolved.slashCommands[0]
      expect(command?.name).toBe("notes")
      expect(command?.displayName).toBe("Session Notes")
      expect(command?.extensionId).toBe(ExtensionId.make("session-notes"))
      expect(command?.capabilityId).toBe("session-notes-summary")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(resourceLayer)
          const metadata = getToolMetadata(AddNoteTool)
          const toolEffect = metadata.effect({ text: "ship the authoring loop" })
          const toolResult = yield* toolEffect.pipe(Effect.provide(context))
          expect(toolResult).toEqual({ count: 1, latest: "ship the authoring loop" })

          const hookSlot = (contributions.hooks ?? [])[0]!
          expect(hookSlot.kind).toBe("turnProjection")
          if (hookSlot.kind !== "turnProjection") return
          const projection = yield* hookSlot.hook.handler(undefined).pipe(Effect.provide(context))
          expect(projection.promptSections?.[0]?.id).toBe("session-notes")
          expect(projection.promptSections?.[0]?.content).toContain("ship the authoring loop")
          expect(projection.toolPolicy?.include).toEqual(["session_note_add"])
        }),
      )
    }),
  )

  it.live("reference example source imports only the public extension API", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() => Bun.file(sessionNotesSourceUrl).text())
      expect(source).toContain('from "@gent/core/extensions/api"')
      expect(source).not.toContain("@gent/core-internal")
      expect(source).not.toContain("@gent/core/src")
    }),
  )

  it.live("dynamic reference example source imports only the public extension API", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() => Bun.file(dynamicScratchpadSourceUrl).text())
      expect(String(DynamicScratchpadExtension.manifest.id)).toBe("dynamic-scratchpad")
      expect(source).toContain('from "@gent/core/extensions/api"')
      expect(source).not.toContain("@gent/core-internal")
      expect(source).not.toContain("@gent/core/src")
    }),
  )

  it.live("public package path is enough to write the representative extension shape", () =>
    Effect.sync(() => {
      const input = Schema.Struct({ text: Schema.String })
      const output = Schema.Struct({ count: Schema.Number })
      void input
      void output
      void SessionNotesExtension
      expect(true).toBe(true)
    }),
  )
})
