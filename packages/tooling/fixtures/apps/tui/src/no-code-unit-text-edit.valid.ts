// Grapheme edits, list pops and counts that are not text.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// The fixed forms.
export const backspace = (state: unknown) => editText(state, dropLastGrapheme)
export const keyMask = (value: string) => "*".repeat(graphemeCount(value))
export const btwBackspace = () => setDraft(dropLastGrapheme)

// A list pop: a local, a member, a call result, and a parameter typed as a list.
export const statements = (raw: string) => {
  const lines = raw.split("\n")
  const ended = lines.slice(0, -1)
  return [...ended, ...splitStatements(raw).slice(0, -1)]
}
export const back = (current: { levelStack: ReadonlyArray<string> }) => ({
  levelStack: current.levelStack.slice(0, -1),
})
export const pop = (stack: ReadonlyArray<string>) => stack.slice(0, -1)

// A spread that is not joined back to text may be any list.
export const firstFiles = (files: ReadonlyArray<string>) => [...new Set(files)].slice(0, 3)

// Graphemes, not code points.
export const firstTwo = (value: string) =>
  Array.from(graphemes.segment(value), (part) => part.segment)
    .slice(0, 2)
    .join("")
export const lastOne = (value: string) =>
  [...graphemes.segment(value)].slice(-1).map((part) => part.segment).join("")

// A local `Array` is not the global one.
export function shadowed(Array: { from: (text: string) => string[] }, text: string) {
  return Array.from(text).slice(0, 1).join("")
}

// A known trailing ASCII mark, on a local.
export const unquote = (raw: string) => {
  const ref = raw.trim()
  if (ref.endsWith('"')) return ref.slice(0, -1)
  return ref
}

// A pad by an ASCII marker plus one, and a rule by width.
export const indent = (marker: string) => " ".repeat(marker.length + 1)
export const rule = (width: number) => "─".repeat(width)

// A fixed-count cut of an ASCII id.
export const toolCallIdentity = (identity: string) =>
  identity.length <= 14 ? identity : `${identity.slice(0, 8)}…${identity.slice(-4)}`
