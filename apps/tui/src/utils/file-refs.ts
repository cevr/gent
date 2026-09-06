/**
 * File reference parsing, expansion, and display links.
 * Supports @path/to/file.ts#10-20 syntax.
 */

import { FileSystem, Effect, Option } from "effect"
import { relativePath, resolvePath } from "../platform/path-runtime"

export interface FileRef {
  path: string
  startLine?: number
  endLine?: number
}

const FILE_REF_PATTERN = /@([^\s#]+)(?:#(\d+)(?:-(\d+))?)?/g

export function isAbsPath(path: string): boolean {
  return path.startsWith("/")
}

export function fileUrl(path: string): string {
  return `file://${path}`
}

/**
 * Parse file references from text
 * @example "@src/foo.ts" → { path: "src/foo.ts" }
 * @example "@src/foo.ts#10" → { path: "src/foo.ts", startLine: 10 }
 * @example "@src/foo.ts#10-20" → { path: "src/foo.ts", startLine: 10, endLine: 20 }
 */
export function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  const pattern = new RegExp(FILE_REF_PATTERN.source, "g")
  for (const match of text.matchAll(pattern)) {
    const path = Option.fromNullishOr(match[1])
    if (Option.isNone(path) || path.value.length === 0) continue

    const ref: FileRef = { path: path.value }
    const startLine = Option.fromNullishOr(match[2])
    if (Option.isSome(startLine)) {
      ref.startLine = parseInt(startLine.value, 10)
      const endLine = Option.fromNullishOr(match[3])
      if (Option.isSome(endLine)) {
        ref.endLine = parseInt(endLine.value, 10)
      }
    }
    refs.push(ref)
  }

  return refs
}

/**
 * Read file content, optionally extracting line range
 */
const readFileContent = (
  absolutePath: string,
  startLine: Option.Option<number>,
  endLine: Option.Option<number>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(absolutePath, "utf-8")

    if (Option.isNone(startLine)) {
      return content
    }

    const lines = content.split("\n")
    const start = Math.max(0, startLine.value - 1) // Convert 1-indexed to 0-indexed
    let end = start + 1
    if (Option.isSome(endLine)) end = Math.min(lines.length, endLine.value)

    return lines.slice(start, end).join("\n")
  })

const expandSingleRef = (ref: FileRef, cwd: string) => {
  const absolutePath = resolvePath(cwd, ref.path)
  const relativePathValue = relativePath(cwd, absolutePath)
  const startLine = Option.fromNullishOr(ref.startLine)
  const endLine = Option.fromNullishOr(ref.endLine)

  return Effect.gen(function* () {
    const content = yield* readFileContent(absolutePath, startLine, endLine)

    // Build the original match string
    let matchStr = `@${ref.path}`
    if (Option.isSome(startLine)) {
      matchStr += `#${startLine.value}`
      if (Option.isSome(endLine)) {
        matchStr += `-${endLine.value}`
      }
    }

    // Build range label
    let rangeLabel = relativePathValue
    if (Option.isSome(startLine)) {
      rangeLabel += `:${startLine.value}`
      if (Option.isSome(endLine)) {
        rangeLabel += `-${endLine.value}`
      }
    }

    // Build code block
    const codeBlock = `\`\`\`${rangeLabel}\n${content}\n\`\`\``
    return Option.some({ matchStr, codeBlock })
  }).pipe(Effect.catchEager(() => Effect.succeedNone))
}

/**
 * Expand file references in text by reading file contents
 * @example "@src/foo.ts#10-20" → "```src/foo.ts:10-20\n<content>\n```"
 */
export const expandFileRefs = (text: string, cwd: string) => {
  const refs = parseFileRefs(text)
  if (refs.length === 0) return Effect.succeed(text)

  return Effect.gen(function* () {
    const expanded = yield* Effect.forEach(refs, (ref) => expandSingleRef(ref, cwd), {
      concurrency: 16,
    })

    let result = text
    for (const exp of expanded) {
      if (Option.isSome(exp)) {
        result = result.replace(exp.value.matchStr, exp.value.codeBlock)
      }
    }

    return result
  })
}
