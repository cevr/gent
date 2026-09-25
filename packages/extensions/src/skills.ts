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
  Result,
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

// Test seam: only tests read these exports. SkillEntry, parseSkillFile and
// formatSkillsForPrompt are pure with unit tests; bundledSkillFiles and
// installBundledSkills let a test install the bundled skills into a scratch home;
// Skills.Test gives a test a fixed skill list.

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

export const SkillEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  level: SkillLevel,
})
export type SkillEntry = typeof SkillEntry.Type

// Skills Service Interface
//
// `Skills` is a read-only surface: it exposes the skill set the Live layer
// loads once, at setup, and has no reload.

interface SkillsService {
  readonly list: Effect.Effect<ReadonlyArray<SkillEntry>>
}

export class Skills extends Context.Service<Skills, SkillsService>()(
  "@gent/extensions/src/skills",
) {
  static Live = (options: {
    cwd: string
    home: string
  }): Layer.Layer<Skills, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
    Layer.effect(
      Skills,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        // A skills dir is user-owned and shared across workspaces: one
        // dangling link or unreadable file must not fail the branch loop.
        // Neither does an unwritable bundle cache or an unreadable ancestor
        // of the working directory. Each failing path is skipped with a
        // warning.
        const skipOnError =
          (target: string) =>
          <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
            effect.pipe(
              Effect.asSome,
              Effect.catch((error) =>
                Effect.logWarning("skills: skipped a failing path").pipe(
                  Effect.annotateLogs({ path: target, error: String(error) }),
                  Effect.as(Option.none<A>()),
                ),
              ),
            )

        const loadSkillsFromDir = (dir: string, level: SkillLevel): Effect.Effect<SkillEntry[]> =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
            if (!exists) return []

            const entries = yield* fs.readDirectory(dir).pipe(skipOnError(dir))
            if (Option.isNone(entries)) return []
            const result: SkillEntry[] = []

            for (const entry of entries.value) {
              const entryPath = path.join(dir, entry)
              const stat = yield* fs.stat(entryPath).pipe(skipOnError(entryPath))
              if (Option.isNone(stat)) continue

              // A skill is either `<dir>/<name>.md` or `<dir>/<name>/SKILL.md`.
              let filePath = Option.none<string>()
              if (stat.value.type === "File" && entry.endsWith(".md")) {
                filePath = Option.some(entryPath)
              } else if (stat.value.type === "Directory") {
                const skillPath = path.join(entryPath, "SKILL.md")
                const hasSkill = yield* fs.exists(skillPath).pipe(Effect.orElseSucceed(() => false))
                if (hasSkill) filePath = Option.some(skillPath)
              }
              if (Option.isNone(filePath)) continue

              const text = yield* fs
                .readFileString(filePath.value)
                .pipe(skipOnError(filePath.value))
              if (Option.isNone(text)) continue
              result.push({ ...parseSkillFile(text.value, entry), filePath: filePath.value, level })
            }

            return result
          })

        // Find git root by walking up from cwd; a failed walk stops at cwd.
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
            const skills: SkillEntry[] = []
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
          const bundled = yield* installBundledSkills(options.home).pipe(
            skipOnError(path.join(options.home, ".cache", "gent", "skills")),
          )
          const globalDirs = [
            ...SKILL_DIRS.map((d) => path.join(options.home, d)),
            ...Option.toArray(bundled),
          ]

          // ── Local sources ──
          // Walk from cwd up to git root, collecting skill dirs at each ancestor.
          // Closest to cwd wins dedup within local level.
          const gitRoot = yield* findGitRoot.pipe(
            skipOnError(options.cwd),
            Effect.map(Option.flatten),
          )
          const stopAt = Option.getOrElse(gitRoot, () => options.cwd)

          // A local dir that is also a global dir (a session in the home
          // directory) is listed once, as global.
          const localDirs: string[] = []
          let current = options.cwd
          while (true) {
            for (const d of SKILL_DIRS) {
              const dir = path.join(current, d)
              if (!globalDirs.includes(dir)) localDirs.push(dir)
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

  static Test = (testSkills: ReadonlyArray<SkillEntry> = []): Layer.Layer<Skills> =>
    Layer.succeed(Skills, Skills.of({ list: Effect.succeed(testSkills) }))
}

// Parse skill file with frontmatter

/** The frontmatter keys a skill reads; any other key, or a non-text value, is ignored. */
const SkillFrontmatter = Schema.Struct({
  name: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.Unknown),
})
const decodeFrontmatter = Schema.decodeUnknownOption(SkillFrontmatter)
const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString)

interface SkillHeader {
  readonly name: Option.Option<string>
  readonly description: Option.Option<string>
}

const NO_HEADER: SkillHeader = { name: Option.none(), description: Option.none() }

/** One prompt line: a folded or literal block scalar collapses to single spaces. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Parse YAML frontmatter; malformed YAML or a non-mapping reads as no header. */
const parseFrontmatter = (yaml: string): SkillHeader =>
  Option.match(
    // oxlint-disable-next-line gent/no-bun-outside-adapter -- Pure YAML parse with no Effect platform service; the cell runtime is full Bun.
    Result.try(() => Bun.YAML.parse(yaml)).pipe(
      Result.getSuccess,
      Option.flatMap(decodeFrontmatter),
    ),
    {
      onNone: () => NO_HEADER,
      onSome: (raw) => {
        const text = (field: typeof raw.name) =>
          decodeText(field).pipe(
            Option.map(oneLine),
            Option.filter((line) => line.length > 0),
          )
        return { name: text(raw.name), description: text(raw.description) }
      },
    },
  )

export function parseSkillFile(content: string, filename: string) {
  let header = NO_HEADER
  let body = content
  const lines = content.split("\n")
  if (lines[0]?.trim() === "---") {
    const endIndex = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
    if (endIndex > 0) {
      header = parseFrontmatter(lines.slice(1, endIndex).join("\n"))
      body = lines
        .slice(endIndex + 1)
        .join("\n")
        .trim()
    }
  }

  const name = Option.getOrElse(header.name, () => filename.replace(/\.md$/, ""))
  // Without a description key, the first body paragraph (minus a heading) describes the skill.
  const description = header.description.pipe(
    Option.orElse(() =>
      Option.fromNullishOr(body.split(/\r?\n\r?\n/)[0]).pipe(
        // Cut at a code point: a UTF-16 slice can split a surrogate pair.
        Option.map((paragraph) =>
          Array.from(oneLine(paragraph.replace(/^#.*(\r?\n|$)/, "")))
            .slice(0, 100)
            .join(""),
        ),
        Option.filter((text) => text.length > 0),
      ),
    ),
    Option.getOrElse(() => `Skill: ${name}`),
  )

  return { name, description }
}

// Format skills for system prompt

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const COMPACT_DESCRIPTION_CHARS = 110
/** A lead shorter than this ("Stop.") says too little; the next sentence joins it. */
const COMPACT_DESCRIPTION_MIN_CHARS = 40

/**
 * A description's lead: its first sentence, and the ones after it while the
 * lead is under 40 characters. Cut at a code point to about 110 characters.
 */
const firstSentence = (description: string): string => {
  let lead = ""
  for (const sentence of description.split(/(?<=[.!?])\s+/)) {
    if (lead.length >= COMPACT_DESCRIPTION_MIN_CHARS) break
    lead = `${lead} ${sentence}`.trim()
  }
  const points = Array.from(lead)
  if (points.length <= COMPACT_DESCRIPTION_CHARS) return lead
  return `${points
    .slice(0, COMPACT_DESCRIPTION_CHARS - 1)
    .join("")
    .trimEnd()}…`
}

/**
 * Where a skill file sits: its skills directory, and the file relative to it.
 * A skill is `<directory>/<name>/SKILL.md` or `<directory>/<file>.md`.
 */
const skillLocation = (skill: SkillEntry) => {
  const parts = skill.filePath.split("/")
  let depth = 1
  if (parts.at(-1) === "SKILL.md" && parts.length > 2) depth = 2
  return {
    directory: parts.slice(0, -depth).join("/"),
    file: parts.slice(-depth).join("/"),
  }
}

const formatList = (list: ReadonlyArray<SkillEntry>): string => {
  const byDirectory = new Map<string, Array<string>>()
  for (const skill of list) {
    const { directory, file } = skillLocation(skill)
    let named = ""
    if (file !== `${skill.name}/SKILL.md`) named = ` (${file})`
    const lines = byDirectory.get(directory) ?? []
    lines.push(`- ${skill.name}${named}: ${firstSentence(skill.description)}`)
    byDirectory.set(directory, lines)
  }
  return Array.from(
    byDirectory,
    ([directory, lines]) => `Directory ${quoted(directory)}:\n${lines.join("\n")}`,
  ).join("\n")
}

const READ_RULE = `Each skill's file is <directory>/<name>/SKILL.md unless another file is named in parentheses. Read it with the read tool or from a cell when its name or description matches the task.`

/**
 * The turn prompt lists skills compactly: each skills directory once, and
 * each skill by name and lead sentence. The file path follows from the
 * directory; the model reads the full text on demand. The listing is sent on
 * every request, so it gives names and paths up front and content on read.
 */
export const formatSkillsForPrompt = (skills: ReadonlyArray<SkillEntry>): string => {
  if (skills.length === 0) return ""

  const globalSkills = skills.filter((s) => s.level === "global")
  const localSkills = skills.filter((s) => s.level === "local")

  const sections: string[] = []

  if (localSkills.length > 0) {
    sections.push(`## Local\n${formatList(localSkills)}`)
  }
  if (globalSkills.length > 0) {
    sections.push(`## Global\n${formatList(globalSkills)}`)
  }

  return `<available_skills>
${sections.join("\n\n")}

${READ_RULE} Paths are on the session server. Resolve relative references from that file’s directory.
When you see \`$skill-name\`, read the local skill first, or the global skill if no local skill exists. Use \`$skill:local\` or \`$skill:global\` to select that level explicitly. Report missing skills or files; do not silently substitute a different scope.
</available_skills>`
}

// ── protocol ────────────────────────────────────────────────────────────────

const SKILLS_EXTENSION_ID = ExtensionId.make("@gent/skills")

export const SkillsRpc = defineRequests(SKILLS_EXTENSION_ID, {
  ListSkills: request({
    id: "skills-list",
    description: "List loaded skills",
    answersDuringTurn: true,
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
 * @gent/skills extension: exposes user and project skills (`.md` files under
 * the `SKILL_DIRS` of the home directory and of each directory from the
 * working directory up to its git root) and the bundled skills to agents.
 *
 * The Skills service is branch-scoped: skills are read from disk once per
 * branch, so a new branch picks up skills added since. Request RPCs and the
 * turn projection read it directly.
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
