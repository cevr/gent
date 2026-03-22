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
  [/\bgit\s+clean\s+-[fd]/, "git clean"],
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
  [/\bnpx\s+/, "npx (remote package execution)"],
]

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\.env\b/, "touches .env file"],
  [/credentials/i, "touches credentials"],
  [/\bsecrets?\b/i, "touches secrets"],
  [/\bid_rsa\b/, "touches SSH key"],
  [/\.pem\b/, "touches .pem file"],
  [/\.key\b/, "touches .key file"],
  [/password/i, "touches password file"],
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

  for (const [pattern, reason] of SENSITIVE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: "sensitive", reason }
    }
  }

  return SAFE
}
