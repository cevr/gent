import { createPatch } from "diff"
import { Option, Schema } from "effect"

/**
 * Detect filetype from path extension
 */
// eslint-disable-next-line effect/noNullish -- unknown extensions have no syntax highlighter.
export function getFiletype(path: string): string | undefined {
  const ext = Option.fromNullishOr(path.split(".").pop()).pipe(
    Option.map((value) => value.toLowerCase()),
  )
  const map = new Map([
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["js", "javascript"],
    ["jsx", "jsx"],
    ["py", "python"],
    ["rs", "rust"],
    ["go", "go"],
    ["md", "markdown"],
    ["json", "json"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["toml", "toml"],
  ])
  return Option.getOrUndefined(
    ext.pipe(Option.flatMap((key) => Option.fromNullishOr(map.get(key)))),
  )
}

/**
 * Count lines added/removed from old and new strings
 */
export interface DiffLineCount {
  readonly added: number
  readonly removed: number
}

export function countDiffLines(oldStr: string, newStr: string): DiffLineCount {
  let oldLines = 0
  if (oldStr.length > 0) oldLines = oldStr.split("\n").length
  let newLines = 0
  if (newStr.length > 0) newLines = newStr.split("\n").length
  if (newLines > oldLines) {
    return { added: newLines - oldLines, removed: 0 }
  } else if (oldLines > newLines) {
    return { added: 0, removed: oldLines - newLines }
  }
  // Same line count - count actual changed lines
  const oldArr = oldStr.split("\n")
  const newArr = newStr.split("\n")
  let changed = 0
  for (let i = 0; i < oldArr.length; i++) {
    if (oldArr[i] !== newArr[i]) changed++
  }
  return { added: changed, removed: changed }
}

export interface EditDiffResult {
  diff: string
  // eslint-disable-next-line effect/noNullish -- syntax highlighting has no filetype for unknown extensions.
  filetype: string | undefined
  added: number
  removed: number
}

/**
 * Generate unified diff from edit input for <diff> component
 */
const decodeEditInput = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
type EditInput = Parameters<typeof decodeEditInput>[0]

export function getEditUnifiedDiff(input: EditInput) {
  const result = Option.gen(function* () {
    const record = yield* decodeEditInput(input)
    const path = yield* decodeString(record["path"])
    const oldStr = yield* decodeString(record["oldString"]).pipe(
      Option.orElse(() => decodeString(record["old_string"])),
    )
    const newStr = yield* decodeString(record["newString"]).pipe(
      Option.orElse(() => decodeString(record["new_string"])),
    )
    const diff = createPatch(path, oldStr, newStr)
    const filetype = getFiletype(path)
    const { added, removed } = countDiffLines(oldStr, newStr)
    return { diff, filetype, added, removed } satisfies EditDiffResult
  })
  return Option.getOrNull(result)
}
