/**
 * Bash command classification for guardrails.
 *
 * Regex-based heuristic that flags destructive, external, and sensitive
 * commands for per-invocation permission prompts. NOT routed through
 * the Permission service (which would create blanket bash exemptions).
 */

export type RiskLevel = "safe" | "destructive" | "external" | "sensitive"

export interface BashRisk {
  level: RiskLevel
  reason: string
}

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-\w*[rf]\w*\s+|.*--recursive|.*--force)/, "rm with -r/-f flags"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
  [/\bgit\s+push\s+.*--force\b/, "git push --force"],
  [/\bgit\s+push\s+-f\b/, "git push -f"],
  [/\bgit\s+clean\b/, "git clean"],
  [/\bgit\s+checkout\s+--?\s/, "git checkout -- (discard changes)"],
  [/\bgit\s+restore\s+--staged\b/, "git restore --staged"],
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\btruncate\s+table\b/i, "TRUNCATE TABLE"],
  [/\bkill\s+-9\b/, "kill -9"],
  [/\bpkill\b/, "pkill"],
  [/\bmkfs\b/, "mkfs (format filesystem)"],
  [/\bdd\s+if=/, "dd (raw disk write)"],
  [/\bsudo\s+rm\b/, "sudo rm"],
]

const EXTERNAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bcurl\b.*\|\s*(ba)?sh\b/, "curl piped to shell"],
  [/\bwget\b.*\|\s*(ba)?sh\b/, "wget piped to shell"],
  [/\bnpm\s+publish\b/, "npm publish"],
  [/\bdocker\s+push\b/, "docker push"],
  [/\bgit\s+push\b(?!.*--force)(?!.*-f)/, "git push"],
  [/\bpip\s+upload\b/, "pip upload"],
]

// Sensitive patterns only match write-context commands, not read-only tools
// like grep/rg/cat/less/head/tail that may reference these filenames
const READ_ONLY_PREFIX = /^\s*(cat|less|head|tail|grep|rg|ag|ack|wc|file|stat|ls|bat|find)\b/
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.env\b/, "modifies .env file"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*credentials/i, "modifies credentials"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\bsecrets?\b/i, "modifies secrets"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\bid_rsa\b/, "modifies SSH key"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.pem\b/, "modifies .pem file"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.key\b/, "modifies .key file"],
]

const SAFE: BashRisk = { level: "safe", reason: "" }

export function classify(command: string): BashRisk {
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: "destructive", reason }
    }
  }

  for (const [pattern, reason] of EXTERNAL_PATTERNS) {
    if (pattern.test(command)) {
      return { level: "external", reason }
    }
  }

  // Skip sensitive check for read-only commands
  if (!READ_ONLY_PREFIX.test(command)) {
    for (const [pattern, reason] of SENSITIVE_PATTERNS) {
      if (pattern.test(command)) {
        return { level: "sensitive", reason }
      }
    }
  }

  return SAFE
}
