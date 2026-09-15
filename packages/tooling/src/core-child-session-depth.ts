/**
 * Guard: every child-session writer in core admits the nesting depth.
 *
 * `DEFAULT_MAX_AGENT_RUN_DEPTH` is enforced in one place,
 * `admitChildSessionDepth` (`packages/core/src/runtime/session-depth.ts`).
 * A file that builds a `new Session({ ... parentSessionId: ... })` row is a
 * child-session writer and must call that admission, or a new writer (the
 * compaction handoff once did) nests sessions without bound.
 *
 * Storage readers rebuild rows from the database and test fixtures seed
 * chains on purpose; both are outside the rule.
 *
 * @module
 */

export interface ChildSessionDepthFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const CORE_SRC = "packages/core/src/"
const EXEMPT_PREFIXES = [`${CORE_SRC}storage/`, `${CORE_SRC}test-utils/`]
const SHARED_CHECK = "admitChildSessionDepth"
const SESSION_LITERAL = /new Session\(\{/g

/** Report `new Session({...parentSessionId...})` in a core file that never admits depth. */
export const findUnadmittedChildSessionWriters = (
  file: string,
  text: string,
): ReadonlyArray<ChildSessionDepthFinding> => {
  if (!file.startsWith(CORE_SRC)) return []
  if (EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix))) return []
  if (file.endsWith("/session-depth.ts")) return []
  if (new RegExp(`\\b${SHARED_CHECK}\\(`).test(text)) return []

  const findings: ChildSessionDepthFinding[] = []
  for (const match of text.matchAll(SESSION_LITERAL)) {
    const start = match.index
    const end = text.indexOf("})", start)
    if (end === -1) continue
    const literal = text.slice(start, end)
    if (!/\bparentSessionId:/.test(literal)) continue
    findings.push({
      file,
      line: text.slice(0, start).split("\n").length,
      message: `child-session writer never calls \`${SHARED_CHECK}\`; every \`parentSessionId\` writer admits the nesting cap through \`runtime/session-depth.ts\``,
    })
  }
  return findings
}
