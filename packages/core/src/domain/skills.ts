import type { PlatformError } from "effect"
import { ServiceMap, Effect, Layer, Ref, Schema, FileSystem, Path } from "effect"

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

export interface SkillsService {
  readonly list: () => Effect.Effect<ReadonlyArray<Skill>>
  readonly get: (name: string, level?: SkillLevel) => Effect.Effect<Skill | undefined>
  readonly reload: () => Effect.Effect<void, PlatformError.PlatformError>
}

// Skills Service Tag

export class Skills extends ServiceMap.Service<Skills, SkillsService>()(
  "@gent/core/src/domain/skills",
) {
  static Live = (options: {
    cwd: string
    home: string
    ignored?: ReadonlyArray<string>
  }): Layer.Layer<Skills, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Skills,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const skillsRef = yield* Ref.make<Skill[]>([])

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
              const filePath = path.join(dir, entry)
              const stat = yield* fs.stat(filePath)

              if (stat.type === "File" && entry.endsWith(".md")) {
                const content = yield* fs.readFileString(filePath)
                const parsed = parseSkillFile(content, entry)
                if (parsed !== null && options.ignored?.includes(parsed.name) !== true) {
                  result.push(
                    new Skill({
                      ...parsed,
                      filePath,
                      level,
                    }),
                  )
                }
              } else if (stat.type === "Directory") {
                // Check for SKILL.md in subdirectory
                const skillPath = path.join(filePath, "SKILL.md")
                const skillExists = yield* fs.exists(skillPath)
                if (skillExists) {
                  const content = yield* fs.readFileString(skillPath)
                  const parsed = parseSkillFile(content, entry)
                  if (parsed !== null && options.ignored?.includes(parsed.name) !== true) {
                    result.push(
                      new Skill({
                        ...parsed,
                        filePath: skillPath,
                        level,
                      }),
                    )
                  }
                }
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
            if (exists) return dir
            const parent = path.dirname(dir)
            if (parent === dir) return undefined
            dir = parent
          }
        })

        const SKILL_DIRS = [".gent/skills", ".claude/skills", ".codex/skills", ".agents/skills"]

        const loadAllSkills = Effect.gen(function* () {
          // ── Global sources ──
          const globalDirs = SKILL_DIRS.map((d) => path.join(options.home, d))

          const globalSkills: Skill[] = []
          const globalSeen = new Set<string>()
          for (const dir of globalDirs) {
            const dirSkills = yield* loadSkillsFromDir(dir, "global")
            for (const skill of dirSkills) {
              if (!globalSeen.has(skill.name)) {
                globalSeen.add(skill.name)
                globalSkills.push(skill)
              }
            }
          }

          // ── Local sources ──
          // Walk from cwd up to git root, collecting skill dirs at each ancestor.
          // Closest to cwd wins dedup within local level.
          const gitRoot = yield* findGitRoot
          const stopAt = gitRoot ?? options.cwd

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

          const localSkills: Skill[] = []
          const localSeen = new Set<string>()
          for (const dir of localDirs) {
            const dirSkills = yield* loadSkillsFromDir(dir, "local")
            for (const skill of dirSkills) {
              if (!localSeen.has(skill.name)) {
                localSeen.add(skill.name)
                localSkills.push(skill)
              }
            }
          }

          return [...localSkills, ...globalSkills]
        })

        // Initial load
        yield* Ref.set(skillsRef, yield* loadAllSkills)

        return {
          list: () => Ref.get(skillsRef),
          get: (name, level) =>
            Ref.get(skillsRef).pipe(Effect.map((skills) => resolveSkillName(skills, name, level))),
          reload: () => loadAllSkills.pipe(Effect.flatMap((loaded) => Ref.set(skillsRef, loaded))),
        }
      }),
    )

  static Test = (testSkills: ReadonlyArray<Skill> = []): Layer.Layer<Skills> =>
    Layer.succeed(Skills, {
      list: () => Effect.succeed(testSkills),
      get: (name, level) => Effect.succeed(resolveSkillName([...testSkills], name, level)),
      reload: () => Effect.void as Effect.Effect<void, PlatformError.PlatformError>,
    })
}

// Resolve a skill name with optional level qualifier

export function resolveSkillName(
  skills: ReadonlyArray<Skill>,
  name: string,
  level?: SkillLevel,
): Skill | undefined {
  // Parse "$skill:level" syntax
  const colonIdx = name.lastIndexOf(":")
  let parsedName = name
  let parsedLevel = level
  if (colonIdx > 0) {
    const suffix = name.slice(colonIdx + 1)
    if (suffix === "local" || suffix === "global") {
      parsedName = name.slice(0, colonIdx)
      parsedLevel = suffix
    }
  }

  // Strip leading $ if present
  if (parsedName.startsWith("$")) {
    parsedName = parsedName.slice(1)
  }

  if (parsedLevel !== undefined) {
    return skills.find((s) => s.name === parsedName && s.level === parsedLevel)
  }

  // No level specified: local first, then global
  return (
    skills.find((s) => s.name === parsedName && s.level === "local") ??
    skills.find((s) => s.name === parsedName && s.level === "global")
  )
}

// Parse skill file with frontmatter

export function parseSkillFile(
  content: string,
  filename: string,
): { name: string; description: string; content: string } | null {
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

      const nameValue = nameMatch?.[1]
      const descValue = descMatch?.[1]
      if (nameValue !== undefined && descValue !== undefined) {
        return {
          name: nameValue.trim(),
          description: descValue.trim(),
          content: body,
        }
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

  return {
    name,
    description: firstPara?.slice(0, 100) ?? `Skill: ${name}`,
    content,
  }
}

// Format skills for system prompt

export const formatSkillsForPrompt = (skills: ReadonlyArray<Skill>): string => {
  if (skills.length === 0) return ""

  const globalSkills = skills.filter((s) => s.level === "global")
  const localSkills = skills.filter((s) => s.level === "local")

  const formatList = (list: ReadonlyArray<Skill>): string =>
    list.map((s) => `- **${s.name}**: ${s.description}`).join("\n")

  const sections: string[] = []

  if (localSkills.length > 0) {
    sections.push(`## Local\n${formatList(localSkills)}`)
  }
  if (globalSkills.length > 0) {
    sections.push(`## Global\n${formatList(globalSkills)}`)
  }

  return `<available_skills>
${sections.join("\n\n")}

Use the \`skills\` tool to load skill content. Use \`search_skills\` to find skills by context.
When you see \`$skill-name\`, load it with the skills tool. Use \`$skill:local\` or \`$skill:global\` to specify level.
</available_skills>`
}
