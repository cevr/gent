function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function uniqueNonEmpty(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of parts) {
    if (part === undefined) continue
    const trimmed = part.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

function extractPrimaryMessage(value: Record<string, unknown>): string | undefined {
  let primary: string | undefined
  if (typeof value["error"] === "string") primary = value["error"]
  else if (typeof value["message"] === "string") primary = value["message"]
  else if (typeof value["summary"] === "string") primary = value["summary"]

  let secondary: string | undefined
  if (typeof value["details"] === "string") secondary = value["details"]
  else if (typeof value["reason"] === "string") secondary = value["reason"]

  const issues = Array.isArray(value["errors"])
    ? value["errors"].filter((item): item is string => typeof item === "string")
    : []

  const parts = uniqueNonEmpty([primary, secondary, ...issues])
  if (parts.length === 0) return undefined
  return parts.join("\n")
}

export function formatGenericToolText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined

  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text

  try {
    const parsed: unknown = JSON.parse(text)

    if (typeof parsed === "string") return parsed

    if (isRecord(parsed)) {
      const extracted = extractPrimaryMessage(parsed)
      if (extracted !== undefined) return extracted
    }

    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}
