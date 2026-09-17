import type { Crypto, PlatformError } from "effect"
import { Context, Effect, Layer, Option, Schema, FileSystem, Path } from "effect"

import { installBundledSkills } from "./bundled-skills.js"

// Skill Schema

export const SkillLevel = Schema.Literals(["local", "global"])
export type SkillLevel = typeof SkillLevel.Type

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

export interface SkillsService {
  readonly list: Effect.Effect<ReadonlyArray<Skill>>
}

export class Skills extends Context.Service<Skills, SkillsService>()(
  "@gent/extensions/src/skills/skills",
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
