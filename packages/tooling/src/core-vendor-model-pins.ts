/**
 * Guard: core must not pin a vendor model SKU.
 *
 * Core is the loop, and the loop does not know which model an install runs.
 * A dated SKU such as `anthropic/claude-haiku-4-5-20251001` compiled into core
 * rots on the vendor's schedule and silently excludes anyone whose only
 * credentials are for another provider.
 *
 * Where core needs a model, it asks the seam that already answers the
 * question -- `resolveDefaultAgentModel` over the registered agents -- and
 * falls back to `DEFAULT_MODEL_ID`, the single declared default.
 *
 * @module
 */

import { Option } from "effect"

/** A core source file that pins a vendor model SKU. */
export interface VendorModelPinFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const CORE_SRC_PREFIX = "packages/core/src/"

/**
 * The one file allowed to name a vendor model: it declares the default that
 * every other core site resolves through.
 */
const DECLARATION_SITE = "packages/core/src/domain/agent.ts"

/**
 * A provider-qualified model id in a string literal, e.g. `"anthropic/claude-…"`.
 * Deliberately narrow: it matches `<provider>/<model>` inside quotes, which is
 * the shape core would use to call `ModelResolver.resolve`.
 */
const VENDOR_MODEL_PATTERN =
  /["'`](?:anthropic|openai|google|mistral|xai|groq|deepseek)\/[a-z0-9][a-z0-9.-]*["'`]/i

/** Report vendor model SKUs pinned in core source. */
export const findCoreVendorModelPins = (
  file: string,
  text: string,
): ReadonlyArray<VendorModelPinFinding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (file === DECLARATION_SITE) return []

  const findings: VendorModelPinFinding[] = []
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const match = Option.fromNullishOr(VENDOR_MODEL_PATTERN.exec(line))
    if (Option.isNone(match)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core pins the vendor model ${match.value[0]}; resolve the model through \`resolveDefaultAgentModel\` and \`DEFAULT_MODEL_ID\` instead`,
    })
  }
  return findings
}
