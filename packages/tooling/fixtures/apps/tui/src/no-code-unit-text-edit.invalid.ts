// The pre-fix shapes of the TUI's text edits, cuts and counts.

// 7a868c61e^ auth.tsx: Backspace dropped one UTF-16 code unit.
export const backspace = (state: unknown) => editText(state, (current) => current.slice(0, -1))

// 7a868c61e^ / 008fdd717^ auth.tsx: one star per code unit.
export const keyMask = (value: string) => "*".repeat(value.length)

// 7a868c61e^ / 008fdd717^ auth.tsx: the field cut by code point, through a const.
export const visibleText = (text: string, room: number) => {
  const chars = [...text]
  if (chars.length <= room) return text
  return "…" + chars.slice(chars.length - (room - 1)).join("")
}

// 5b999034d^ btw.client.tsx: the ask line's backspace by code point.
export const btwBackspace = () => setDraft((current) => [...current].slice(0, -1).join(""))

// 5b999034d^ ui.tsx: the list filter's backspace by code point, from a member.
export const filterBackspace = (state: { query: string }) =>
  [...state.query].slice(0, -1).join("")

// The same cut through `Array.from`.
export const head = (text: string) => Array.from(text).slice(0, 3).join("")

// A typed parameter, and the `length - 1` spelling.
export const erase = (text: string) => text.substring(0, text.length - 1)
export function drop(draft) {
  return draft.slice(0, draft.length - 1)
}

// A template literal glyph.
export const underline = (title: string) => `─`.repeat(title.length)
