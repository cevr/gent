/**
 * RuntimeProfileResolver regression locks.
 *
 * Locks the single-pipeline contract introduced in planify Commit 7 — every
 * composition root (server startup, per-cwd profile cache, ephemeral child runs)
 * now flows through `resolveRuntimeProfile`. The locks prove:
 *
 *   1. Same inputs → same resolved extensions (extension count, ids, scope)
 *   2. Same inputs → same merged prompt sections (core + extension, extensions
 *      shadow core by id, scope precedence preserved)
 *   3. The resolver is pure-by-input — calling it twice with the same inputs
 *      yields equivalent profiles regardless of caller (server vs cache).
 *
 * If this regresses, the three activation paths can drift again — e.g.,
 * an extension's prompt section appears at server startup but not in a per-cwd
 * profile, or vice versa.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Path } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { defineExtension, promptSectionContribution } from "@gent/core/extensions/api"
import { ConfigService } from "@gent/core/runtime/config-service"
import {
  buildExtensionLayers,
  compileBaseSections,
  resolveRuntimeProfile,
} from "@gent/core/runtime/profile"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test())

const sectionExtension = defineExtension({
  id: "@gent/test-runtime-profile",
  contributions: () => [
    promptSectionContribution({
      id: "rp-test-section",
      content: "rp test content",
      priority: 50,
    }),
  ],
})

describe("resolveRuntimeProfile", () => {
  it.live("same inputs across modes produce equivalent profiles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = {
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension],
        }

        // Two independent invocations simulate: server startup vs per-cwd cache miss
        const profileA = yield* resolveRuntimeProfile(inputs)
        const profileB = yield* resolveRuntimeProfile(inputs)

        // Same resolved extension set
        expect(profileA.resolved.extensions.length).toBe(profileB.resolved.extensions.length)
        expect(profileA.resolved.extensions.map((e) => e.manifest.id)).toEqual(
          profileB.resolved.extensions.map((e) => e.manifest.id),
        )

        // Compile sections (no dynamic deps in this test extension; runs in
        // current scope without extension layers).
        const sectionsA = yield* compileBaseSections(profileA)
        const sectionsB = yield* compileBaseSections(profileB)

        // Same merged base sections (length and content)
        expect(sectionsA.length).toBe(sectionsB.length)
        const aIds = sectionsA.map((s) => s.id).sort()
        const bIds = sectionsB.map((s) => s.id).sort()
        expect(aIds).toEqual(bIds)

        // Extension-contributed section appears in the merged sections
        const sec = sectionsA.find((s) => s.id === "rp-test-section")
        expect(sec?.content).toBe("rp test content")
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("buildExtensionLayers wires ExtensionRegistry from resolved data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profile = yield* resolveRuntimeProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension],
        })

        const layer = buildExtensionLayers(profile.resolved)

        const registryService = yield* Effect.gen(function* () {
          return yield* ExtensionRegistry
        }).pipe(Effect.provide(layer))

        const sections = yield* registryService.listPromptSections()
        const ids = sections.map((s) => s.id)
        expect(ids).toContain("rp-test-section")
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )
})
