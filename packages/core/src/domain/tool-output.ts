import type * as Prompt from "effect/unstable/ai/Prompt"

export type ToolOutput = {
  readonly type: "json" | "error-json"
  readonly value: unknown
}

export const stringifyOutput = (value: unknown): string => {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export const summarizeOutput = (output: ToolOutput): string => {
  const value = output.value
  if (typeof value === "string") {
    const firstLine = value.split("\n")[0] ?? ""
    return firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine
  }
  if (value !== null && typeof value === "object") {
    const str = JSON.stringify(value)
    return str.length > 100 ? str.slice(0, 100) + "..." : str
  }
  return String(value)
}

export const summarizeToolOutput = (result: Prompt.ToolResultPart): string =>
  summarizeOutput({ type: result.isFailure ? "error-json" : "json", value: result.result })
