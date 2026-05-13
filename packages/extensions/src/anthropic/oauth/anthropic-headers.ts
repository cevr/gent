import { getModelBetas as deriveModelBetas, MODEL_CONFIG, getCcVersion } from "../model-config.js"
import type { AnthropicKeychainEnv } from "../platform-adapter.js"

export const LONG_CONTEXT_BETAS: ReadonlyArray<string> = MODEL_CONFIG.longContextBetas

export const isLongContextError = (responseBody: string): boolean =>
  responseBody.includes("Extra usage is required for long context requests") ||
  responseBody.includes("long context beta is not yet available")

/**
 * Long-context backoff candidates — only the long-context betas that
 * actually appear in this model's effective header. Counsel deep
 * surfaced two related defects in the prior shape:
 *   1. We walked `LONG_CONTEXT_BETAS` directly, ignoring per-model
 *      overrides — so a haiku request (which excludes
 *      `interleaved-thinking-2025-05-14` via the override) would still
 *      "exclude" it on backoff, burning a retry on a beta that wasn't
 *      sent.
 *   2. The retry budget at the call site was `length - 1`, so the
 *      second exclusion attempt never went on the wire.
 * Both are fixed by deriving candidates from the model's actual
 * outgoing betas and giving each one a retry slot.
 */
export const getLongContextBetasForWith = (
  modelId: string,
  currentBetaFlags: string | undefined,
): ReadonlyArray<string> => {
  const modelBetas = new Set(deriveModelBetas(modelId, currentBetaFlags))
  return LONG_CONTEXT_BETAS.filter((beta) => modelBetas.has(beta))
}

export const getModelBetas = (
  modelId: string,
  betaFlags: string | undefined,
  excluded?: Set<string>,
): ReadonlyArray<string> => deriveModelBetas(modelId, betaFlags, excluded)

export const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * CLI version: the live env wins, otherwise the `MODEL_CONFIG.ccVersion`
 * baseline. Pure function — env comes from the caller's `AnthropicPlatform`.
 */
export const getCliVersion = (env: AnthropicKeychainEnv): string => env.cliVersion ?? getCcVersion()

export const getUserAgent = (env: AnthropicKeychainEnv): string =>
  env.userAgent ?? `claude-cli/${getCliVersion(env)} (external, cli)`

/**
 * Inputs the billing-header builder needs (CLI version + entrypoint).
 * The actual header text is built in `signing.ts` per request because
 * both hashes depend on the live first-user-message text.
 */
export const getBillingHeaderInputs = (
  env: AnthropicKeychainEnv,
): { version: string; entrypoint: string } => ({
  version: getCliVersion(env),
  entrypoint: env.entrypoint ?? "cli",
})

/**
 * Pull the `model` field from a JSON request body. Returns "unknown"
 * for missing/non-string bodies or unparseable JSON. Pure — both the
 * request pipelines read this from their respective request shapes (string
 * body / Uint8Array body) and call this helper to derive the model id used for
 * header construction.
 */
export const parseModelIdFromBody = (bodyText: string | undefined): string => {
  if (bodyText === undefined || bodyText === "") return "unknown"
  try {
    const body: unknown = JSON.parse(bodyText)
    if (typeof body === "object" && body !== null && "model" in body) {
      const m = (body as Record<string, unknown>)["model"]
      if (typeof m === "string") return m
    }
  } catch {
    // ignore — modelId stays "unknown"
  }
  return "unknown"
}
