import type { Schema } from "effect"
import { SchemaIssue } from "effect"

const formatter = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Format a SchemaError into a structured, agent-readable message.
 * Extracts field-level errors with paths so the agent can self-heal.
 *
 * Output format:
 * ```
 * Tool 'edit' input failed:
 *   - field 'file_path': Expected string, got undefined
 *   - field 'old_string': Missing key
 * ```
 */
export const formatSchemaError = (toolName: string, error: Schema.SchemaError): string => {
  const result = formatter(error.issue)
  const issues = result.issues

  if (issues.length === 0) {
    return `Tool '${toolName}' input validation failed: ${error.message}`
  }

  const lines = issues.map((issue) => {
    const path = issue.path?.length ? issue.path.map(String).join(".") : "(root)"
    return `  - ${path}: ${issue.message}`
  })

  // Cap output to avoid flooding context
  const MAX_LINES = 10
  const truncated = lines.length > MAX_LINES
  const displayLines = truncated ? lines.slice(0, MAX_LINES) : lines

  return [
    `Tool '${toolName}' input failed:`,
    ...displayLines,
    ...(truncated ? [`  ... and ${lines.length - MAX_LINES} more`] : []),
  ].join("\n")
}
