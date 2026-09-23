import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import {
  bundledSkillFiles,
  formatSkillsForPrompt,
  installBundledSkills,
  parseSkillFile,
  Skill,
  SkillEntry,
  Skills,
  SkillsExtension,
  SkillsRpc,
} from "../src/skills.js"
import { BunServices } from "@effect/platform-bun"
import { ref } from "@gent/core/extensions/api"
import {
  LanguageModelLayers,
  textStep,
  collectTestContributions,
  createRpcHarness,
} from "@gent/core/test-utils"
import { e2ePreset } from "./helpers/test-preset"

// ── skills/skills.test ──────────────────────────────────────────────────────

const makeSkill = (name: string, level: "local" | "global", description = `${name} skill`) =>
  new Skill({
    name,
    description,
    filePath: `/test/${level}/${name}.md`,
    content: `Content for ${name}`,
    level,
  })

describe("formatSkillsForPrompt", () => {
  test("empty array returns empty string", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })

  test("groups by level", () => {
    const skills = [makeSkill("bun", "local"), makeSkill("react", "global")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("## Local")
    expect(result).toContain("## Global")
    expect(result).toContain("**bun**")
    expect(result).toContain("**react**")
  })

  test("omits empty level sections", () => {
    const skills = [makeSkill("bun", "local")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("## Local")
    expect(result).not.toContain("## Global")
  })

  test("includes usage instructions", () => {
    const skills = [makeSkill("bun", "local")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("read tool")
    expect(result).toContain('File: "/test/local/bun.md"')
    expect(result).toContain("$bun:local")
    expect(result).toContain("$skill:local")
  })
})

describe("parseSkillFile", () => {
  test("parses YAML frontmatter", () => {
    const content = `---
name: effect-v4
description: Effect v4 patterns
---

Content here`
    const result = parseSkillFile(content, "effect-v4.md")
    expect(result).toEqual(
      Option.some({
        name: "effect-v4",
        description: "Effect v4 patterns",
        content: "Content here",
      }),
    )
  })

  test("falls back to filename for name", () => {
    const result = parseSkillFile("# My Skill\n\nSome content", "my-skill.md")
    expect(Option.getOrThrow(result).name).toBe("my-skill")
  })

  test("extracts description from first paragraph", () => {
    const result = parseSkillFile("# Title\nShort description\n\nMore content", "test.md")
    expect(Option.getOrThrow(result).description).toBe("Short description")
  })
})

// ── skills/skills-rpc.test ──────────────────────────────────────────────────

/**
 * Skills RPC acceptance test — exercises SkillsExtension through the full
 * request(...) path with per-request scopes, matching production behavior.
 */

const testSkills = [
  new Skill({
    name: "effect-v4",
    description: "Effect v4 patterns",
    filePath: "/global/effect-v4.md",
    content: "Use Effect.fn for tracing",
    level: "global",
  }),
  new Skill({
    name: "react",
    description: "React component patterns",
    filePath: "/local/react.md",
    content: "Use function components",
    level: "local",
  }),
]

const skillsLayerOverride = { "@gent/skills": () => Skills.Test(testSkills) }

describe("SkillsExtension via RPC", () => {
  it.scopedLive(
    "bundled principles are discoverable through RPC and readable as files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-principles-rpc-" })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [SkillsExtension],
          layerOverrides: {
            "@gent/skills": () =>
              Skills.Live({ home, cwd: home }).pipe(Layer.provide(BunServices.layer), Layer.orDie),
          },
        })
        const raw = yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: ref(SkillsRpc.ListSkills).extensionId,
          capabilityId: ref(SkillsRpc.ListSkills).capabilityId,
          input: {},
        })
        const listed = yield* Schema.decodeUnknownEffect(Schema.Array(SkillEntry))(raw)
        const skill = Option.getOrThrow(
          Option.fromUndefinedOr(listed.find((entry) => entry.name === "principles")),
        )
        expect(yield* fs.readFileString(skill.filePath)).toContain(
          "references/redesign-from-first-principles.md",
        )
        expect(
          yield* fs.readFileString(
            path.join(path.dirname(skill.filePath), "references/redesign-from-first-principles.md"),
          ),
        ).toContain("# Redesign From First Principles")
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )
  it.live("turn projection contributes loaded skills to the prompt", () =>
    Effect.gen(function* () {
      const contributions = yield* collectTestContributions(SkillsExtension.setup)

      const turnProjection = Option.fromUndefinedOr(
        contributions.hooks?.find((slot) => slot.kind === "turnProjection"),
      )
      if (Option.isNone(turnProjection)) {
        return yield* Effect.die(new Error("expected skills turn projection"))
      }
      const result = yield* turnProjection.value.hook
        .handler()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(Skills.Test(testSkills)), Effect.orDie)

      const section = Option.flatMap(Option.fromUndefinedOr(result.promptSections), (sections) =>
        Option.fromUndefinedOr(sections.find((s) => s.id === "skills")),
      )
      if (Option.isNone(section)) {
        return yield* Effect.die(new Error("expected skills prompt section"))
      }
      expect(section.value.content).toContain("effect-v4")
      expect(section.value.content).toContain("react")
    }),
  )

  it.live(
    "ListSkills via request RPC returns skill entries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [SkillsExtension],
            layerOverrides: skillsLayerOverride,
          })

          const rawReply = yield* client.extension.request({
            sessionId,
            extensionId: ref(SkillsRpc.ListSkills).extensionId,
            capabilityId: ref(SkillsRpc.ListSkills).capabilityId,
            input: {},
            branchId,
          })
          const reply = yield* Schema.decodeUnknownEffect(Schema.Array(SkillEntry))(rawReply)

          expect(Array.isArray(reply)).toBe(true)
          expect(reply).toHaveLength(2)
          expect(reply.map((s) => s.name)).toEqual(["effect-v4", "react"])
          expect(reply[0]?.content).toBe("Use Effect.fn for tracing")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── skills/bundled-skills.test ──────────────────────────────────────────────

describe("bundled skills", () => {
  it.scopedLive("concurrent profiles publish one complete bundle of readable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bundled-skills-" })
      const roots = yield* Effect.all([installBundledSkills(home), installBundledSkills(home)], {
        concurrency: 2,
      })
      expect(roots[0]).toBe(roots[1])
      for (const [relativePath, content] of bundledSkillFiles) {
        expect(yield* fs.readFileString(path.join(roots[0], relativePath))).toBe(content)
      }
      expect(yield* fs.readDirectory(path.dirname(roots[0]))).toHaveLength(1)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "user skills override bundled defaults and explicit scope still selects global",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-skill-home-" })
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-skill-project-" })
        const globalDir = path.join(home, ".gent", "skills", "principles")
        const localDir = path.join(cwd, ".gent", "skills", "principles")
        for (const dir of [globalDir, localDir]) yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(
          path.join(globalDir, "SKILL.md"),
          "---\nname: principles\ndescription: User principles\n---\nGLOBAL-PRINCIPLES",
        )
        yield* fs.writeFileString(
          path.join(localDir, "SKILL.md"),
          "---\nname: principles\ndescription: Project principles\n---\nLOCAL-PRINCIPLES",
        )
        yield* Effect.gen(function* () {
          const skills = yield* Skills
          const principles = (yield* skills.list).filter((skill) => skill.name === "principles")
          // Both levels stay listed, local first, so the model can address either.
          expect(principles.map((skill) => skill.level)).toEqual(["local", "global"])
          expect(principles[0]?.content).toContain("LOCAL-PRINCIPLES")
          expect(principles[1]?.content).toContain("GLOBAL-PRINCIPLES")
          // oxlint-disable-next-line effect/noInlineProvide -- This test constructs the real service after acquiring its scoped fixture directories.
        }).pipe(Effect.provide(Skills.Live({ home, cwd })))
      }).pipe(Effect.provide(BunServices.layer)),
  )
})
