// oxlint-disable-next-line typescript/triple-slash-reference -- Downstream source consumers need this ambient Bun text-asset declaration without a runtime import.
/// <reference path="./skills/markdown.d.ts" />
import {
  Context,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schema,
} from "effect"
import {
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionHost,
  ExtensionId,
  request,
} from "@gent/core/extensions/api"

// ── bundled sources ─────────────────────────────────────────────────────────

import acknowledgeBeforeProcessing from "./skills/bundled/principles/references/acknowledge-before-processing.md" with { type: "text" }
import boundaryDiscipline from "./skills/bundled/principles/references/boundary-discipline.md" with { type: "text" }
import chaseYNotX from "./skills/bundled/principles/references/chase-y-not-x.md" with { type: "text" }
import compositionOverFlags from "./skills/bundled/principles/references/composition-over-flags.md" with { type: "text" }
import correctnessOverPragmatism from "./skills/bundled/principles/references/correctness-over-pragmatism.md" with { type: "text" }
import costAwareDelegation from "./skills/bundled/principles/references/cost-aware-delegation.md" with { type: "text" }
import deriveDontSync from "./skills/bundled/principles/references/derive-dont-sync.md" with { type: "text" }
import encodeLessonsInStructure from "./skills/bundled/principles/references/encode-lessons-in-structure.md" with { type: "text" }
import exhaustTheDesignSpace from "./skills/bundled/principles/references/exhaust-the-design-space.md" with { type: "text" }
import experienceFirst from "./skills/bundled/principles/references/experience-first.md" with { type: "text" }
import fixRootCauses from "./skills/bundled/principles/references/fix-root-causes.md" with { type: "text" }
import foundationalThinking from "./skills/bundled/principles/references/foundational-thinking.md" with { type: "text" }
import guardTheContextWindow from "./skills/bundled/principles/references/guard-the-context-window.md" with { type: "text" }
import makeImpossibleStatesUnrepresentable from "./skills/bundled/principles/references/make-impossible-states-unrepresentable.md" with { type: "text" }
import makeOperationsIdempotent from "./skills/bundled/principles/references/make-operations-idempotent.md" with { type: "text" }
import migrateCallersThenDeleteLegacyApis from "./skills/bundled/principles/references/migrate-callers-then-delete-legacy-apis.md" with { type: "text" }
import nameEventsNotSetters from "./skills/bundled/principles/references/name-events-not-setters.md" with { type: "text" }
import neverBlockOnTheHuman from "./skills/bundled/principles/references/never-block-on-the-human.md" with { type: "text" }
import outcomeOrientedExecution from "./skills/bundled/principles/references/outcome-oriented-execution.md" with { type: "text" }
import progressiveDisclosure from "./skills/bundled/principles/references/progressive-disclosure.md" with { type: "text" }
import proveItWorks from "./skills/bundled/principles/references/prove-it-works.md" with { type: "text" }
import redesignFromFirstPrinciples from "./skills/bundled/principles/references/redesign-from-first-principles.md" with { type: "text" }
import serializeSharedStateMutations from "./skills/bundled/principles/references/serialize-shared-state-mutations.md" with { type: "text" }
import smallInterfaceDeepImplementation from "./skills/bundled/principles/references/small-interface-deep-implementation.md" with { type: "text" }
import subtractBeforeYouAdd from "./skills/bundled/principles/references/subtract-before-you-add.md" with { type: "text" }
import testThroughPublicInterfaces from "./skills/bundled/principles/references/test-through-public-interfaces.md" with { type: "text" }
import useThePlatform from "./skills/bundled/principles/references/use-the-platform.md" with { type: "text" }
import principlesSkill from "./skills/bundled/principles/SKILL.md" with { type: "text" }

import repositories from "./skills/bundled/repositories/SKILL.md" with { type: "text" }

export const bundledSkillFiles: ReadonlyArray<readonly [string, string]> = [
  ["repositories/SKILL.md", repositories],
  ["principles/SKILL.md", principlesSkill],
  ["principles/references/acknowledge-before-processing.md", acknowledgeBeforeProcessing],
  ["principles/references/boundary-discipline.md", boundaryDiscipline],
  ["principles/references/chase-y-not-x.md", chaseYNotX],
  ["principles/references/composition-over-flags.md", compositionOverFlags],
  ["principles/references/correctness-over-pragmatism.md", correctnessOverPragmatism],
  ["principles/references/cost-aware-delegation.md", costAwareDelegation],
  ["principles/references/derive-dont-sync.md", deriveDontSync],
  ["principles/references/encode-lessons-in-structure.md", encodeLessonsInStructure],
  ["principles/references/exhaust-the-design-space.md", exhaustTheDesignSpace],
  ["principles/references/experience-first.md", experienceFirst],
  ["principles/references/fix-root-causes.md", fixRootCauses],
  ["principles/references/foundational-thinking.md", foundationalThinking],
  ["principles/references/guard-the-context-window.md", guardTheContextWindow],
  [
    "principles/references/make-impossible-states-unrepresentable.md",
    makeImpossibleStatesUnrepresentable,
  ],
  ["principles/references/make-operations-idempotent.md", makeOperationsIdempotent],
  [
    "principles/references/migrate-callers-then-delete-legacy-apis.md",
    migrateCallersThenDeleteLegacyApis,
  ],
  ["principles/references/name-events-not-setters.md", nameEventsNotSetters],
  ["principles/references/never-block-on-the-human.md", neverBlockOnTheHuman],
  ["principles/references/outcome-oriented-execution.md", outcomeOrientedExecution],
  ["principles/references/progressive-disclosure.md", progressiveDisclosure],
  ["principles/references/prove-it-works.md", proveItWorks],
  ["principles/references/redesign-from-first-principles.md", redesignFromFirstPrinciples],
  ["principles/references/serialize-shared-state-mutations.md", serializeSharedStateMutations],
  [
    "principles/references/small-interface-deep-implementation.md",
    smallInterfaceDeepImplementation,
  ],
  ["principles/references/subtract-before-you-add.md", subtractBeforeYouAdd],
  ["principles/references/test-through-public-interfaces.md", testThroughPublicInterfaces],
  ["principles/references/use-the-platform.md", useThePlatform],
]

// ── bundled skills ──────────────────────────────────────────────────────────

/** Materialize bundled documents so the separate cell process can read their paths. */
export const installBundledSkills = Effect.fn("Skills.installBundled")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const manifest = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
  )(bundledSkillFiles).pipe(Effect.orDie)
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(manifest))
  const parent = path.join(home, ".cache", "gent", "skills")
  const root = path.join(parent, Encoding.encodeHex(digest))
  if (yield* fs.exists(root)) return root
  yield* fs.makeDirectory(parent, { recursive: true })
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory: parent, prefix: ".stage-" }),
    (staging) =>
      Effect.gen(function* () {
        for (const [relativePath, content] of bundledSkillFiles) {
          const target = path.join(staging, relativePath)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFileString(target, content)
        }
        yield* fs.rename(staging, root).pipe(
          Effect.catchEager((error) =>
            Effect.gen(function* () {
              // Another profile may have published the same complete bundle.
              if (!(yield* fs.exists(root))) return yield* error
            }),
          ),
        )
      }),
    (staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie),
  )
  return root
})

// ── skills catalog ──────────────────────────────────────────────────────────

// Skill Schema

const SkillLevel = Schema.Literals(["local", "global"])
type SkillLevel = typeof SkillLevel.Type

export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  content: Schema.String,
  level: SkillLevel,
}) {}

// Skills Service Interface
//
// `Skills` is a read-only surface — it exposes the loaded skill set
// (`list`) but no reload/refresh path. Skill loading runs once
// in the Live layer's setup; if a runtime reload becomes a real need
// later it should arrive as an admin `request` capability or a fresh
// resource start, not a method on the read interface.

interface SkillsService {
  readonly list: Effect.Effect<ReadonlyArray<Skill>>
}

export class Skills extends Context.Service<Skills, SkillsService>()(
  "@gent/extensions/src/skills",
) {
  static Live = (options: {
    cwd: string
    home: string
  }): Layer.Layer<
    Skills,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > =>
    Layer.effect(
      Skills,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const loadSkillsFromDir = (
          dir: string,
          level: SkillLevel,
        ): Effect.Effect<Skill[], PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(dir)
            if (!exists) return []

            const entries = yield* fs.readDirectory(dir)
            const result: Skill[] = []

            for (const entry of entries) {
              const entryPath = path.join(dir, entry)
              const stat = yield* fs.stat(entryPath)

              // A skill is either `<dir>/<name>.md` or `<dir>/<name>/SKILL.md`.
              let filePath = Option.none<string>()
              if (stat.type === "File" && entry.endsWith(".md")) {
                filePath = Option.some(entryPath)
              } else if (stat.type === "Directory") {
                const skillPath = path.join(entryPath, "SKILL.md")
                if (yield* fs.exists(skillPath)) filePath = Option.some(skillPath)
              }
              if (Option.isNone(filePath)) continue

              const parsed = parseSkillFile(yield* fs.readFileString(filePath.value), entry)
              if (Option.isSome(parsed)) {
                result.push(new Skill({ ...parsed.value, filePath: filePath.value, level }))
              }
            }

            return result
          })

        // Find git root by walking up from cwd
        const findGitRoot = Effect.gen(function* () {
          let dir = options.cwd
          while (true) {
            const gitDir = path.join(dir, ".git")
            const exists = yield* fs.exists(gitDir)
            if (exists) return Option.some(dir)
            const parent = path.dirname(dir)
            if (parent === dir) return Option.none<string>()
            dir = parent
          }
        })

        const SKILL_DIRS = [".gent/skills", ".claude/skills", ".codex/skills", ".agents/skills"]

        // Load every dir at one level, in order; the first dir to name a skill wins.
        const loadLevel = (dirs: ReadonlyArray<string>, level: SkillLevel) =>
          Effect.gen(function* () {
            const skills: Skill[] = []
            const seen = new Set<string>()
            for (const dir of dirs) {
              for (const skill of yield* loadSkillsFromDir(dir, level)) {
                if (seen.has(skill.name)) continue
                seen.add(skill.name)
                skills.push(skill)
              }
            }
            return skills
          })

        const loadAllSkills = Effect.gen(function* () {
          // ── Global sources ──
          const globalDirs = [
            ...SKILL_DIRS.map((d) => path.join(options.home, d)),
            yield* installBundledSkills(options.home),
          ]

          // ── Local sources ──
          // Walk from cwd up to git root, collecting skill dirs at each ancestor.
          // Closest to cwd wins dedup within local level.
          const gitRoot = yield* findGitRoot
          const stopAt = Option.getOrElse(gitRoot, () => options.cwd)

          const localDirs: string[] = []
          let current = options.cwd
          while (true) {
            for (const d of SKILL_DIRS) {
              localDirs.push(path.join(current, d))
            }
            if (current === stopAt) break
            const parent = path.dirname(current)
            if (parent === current) break
            current = parent
          }

          return [
            ...(yield* loadLevel(localDirs, "local")),
            ...(yield* loadLevel(globalDirs, "global")),
          ]
        })

        // Initial load
        const skills = yield* loadAllSkills

        return Skills.of({ list: Effect.succeed(skills) })
      }),
    )

  static Test = (testSkills: ReadonlyArray<Skill> = []): Layer.Layer<Skills> =>
    Layer.succeed(Skills, Skills.of({ list: Effect.succeed(testSkills) }))
}

// Parse skill file with frontmatter

export function parseSkillFile(
  content: string,
  filename: string,
): Option.Option<{ name: string; description: string; content: string }> {
  const lines = content.split("\n")

  // Check for YAML frontmatter
  if (lines[0]?.trim() === "---") {
    const endIndex = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
    if (endIndex > 0) {
      const frontmatter = lines.slice(1, endIndex).join("\n")
      const body = lines
        .slice(endIndex + 1)
        .join("\n")
        .trim()

      // Simple YAML parsing for name and description
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

      const nameValue = Option.fromNullishOr(nameMatch?.[1])
      const descValue = Option.fromNullishOr(descMatch?.[1])
      if (Option.isSome(nameValue) && Option.isSome(descValue)) {
        return Option.some({
          name: nameValue.value.trim(),
          description: descValue.value.trim(),
          content: body,
        })
      }
    }
  }

  // No frontmatter - use filename as name
  const name = filename.replace(/\.md$/, "").replace(/^SKILL$/, filename.replace(/\.md$/, ""))

  // Try to extract description from first paragraph
  const firstPara = content
    .split("\n\n")[0]
    ?.replace(/^#.*\n/, "")
    .trim()

  return Option.some({
    name,
    description: Option.getOrElse(
      Option.fromNullishOr(firstPara).pipe(Option.map((value) => value.slice(0, 100))),
      () => `Skill: ${name}`,
    ),
    content,
  })
}

// Format skills for system prompt

export const formatSkillsForPrompt = (skills: ReadonlyArray<Skill>): string => {
  if (skills.length === 0) return ""

  const globalSkills = skills.filter((s) => s.level === "global")
  const localSkills = skills.filter((s) => s.level === "local")

  const formatList = (list: ReadonlyArray<Skill>): string =>
    list
      .map(
        (s) =>
          `- **${s.name}** ($${s.name}:${s.level}): ${s.description}\n  File: ${Schema.encodeSync(Schema.fromJsonString(Schema.String))(s.filePath)}`,
      )
      .join("\n")

  const sections: string[] = []

  if (localSkills.length > 0) {
    sections.push(`## Local\n${formatList(localSkills)}`)
  }
  if (globalSkills.length > 0) {
    sections.push(`## Global\n${formatList(globalSkills)}`)
  }

  return `<available_skills>
${sections.join("\n\n")}

Read a listed file with the read tool or from a cell when its name or description matches the task. Paths are on the session server. Resolve relative references from that file’s directory.
When you see \`$skill-name\`, read the local skill first, or the global skill if no local skill exists. Use \`$skill:local\` or \`$skill:global\` to select that level explicitly. Report missing skills or files; do not silently substitute a different scope.
</available_skills>`
}

// ── protocol ────────────────────────────────────────────────────────────────

const SKILLS_EXTENSION_ID = ExtensionId.make("@gent/skills")

export const SkillEntry = Schema.Struct(Skill.fields)
export type SkillEntry = typeof SkillEntry.Type

export const SkillsRpc = defineRequests(SKILLS_EXTENSION_ID, {
  ListSkills: request({
    id: "skills-list",
    description: "List loaded skills",
    input: Schema.Struct({}),
    output: Schema.Array(SkillEntry),
    execute: Effect.fn("SkillsRpc.ListSkills")(function* () {
      const skills = yield* Skills
      return yield* skills.list
    }),
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * @gent/skills extension — exposes user/project skills (`.md` files
 * under `~/.claude/skills/` and `<cwd>/.claude/skills/`) to agents.
 *
 * The Skills service is branch-scoped. Skills are read from disk once per
 * branch and never reload (`skills.ts`), so branch lifetime is the honest
 * lifetime: a new branch picks up skills added since, and nothing outlives
 * the loop that read them. Request RPCs and the turn projection read it
 * directly; no actor mirror is needed.
 */

// ── Extension ──

export const SkillsExtension = defineExtension({
  id: "@gent/skills",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/skills/service",
        tag: Skills,
        scope: "branch",
        layer: Skills.Live({ cwd: host.cwd, home: host.home }),
      }),
    )
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const service = yield* Skills
        const skills = yield* service.list
        return {
          promptSections: [{ id: "skills", priority: 80, content: formatSkillsForPrompt(skills) }],
        }
      }),
    )
    yield* host.register("request", SkillsRpc.ListSkills)
  }),
})
