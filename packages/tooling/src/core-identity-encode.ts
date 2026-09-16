/**
 * Guard: a whole-object JSON encode must not decide identity.
 *
 * `JSON.stringify` carries key order, so two spellings of the same value
 * encode to different strings. Native history compared transcript items that
 * way and the feed built one message two ways — `_tag` first from the
 * streaming placeholder, `_tag` last from the rebuild. A rebuilt message read
 * as a different message, the committed prefix broke, and the replay cleared
 * the terminal's saved lines. The fix names the compared fields in a fixed
 * order instead; this guard keeps the next comparison from regressing to an
 * encode of the object.
 *
 * What is reported: a value encoded by `Schema.encodeSync(Schema.fromJsonString(...))`
 * whose result is then compared with `===`, `!==`, `.has(`, or `.get(` on the
 * same line, or stored under a name that says it is an identity. Encoding for
 * a log line, a file, or a display string is untouched — those do not compare.
 *
 * @module
 */

import { Option } from "effect"

export interface IdentityEncodeFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const SHIPPED_SOURCE = /^(?:packages|apps)\/[^/]+\/(?:[^/]+\/)*src\//

/** Names that say the encoded value answers "is this the same thing?". */
const IDENTITY_NAMES = /\b(?:fingerprint|identity|signature|dedupe|dedup|cacheKey|key)\b/i

/** A binding whose initializer is a whole-object JSON encoder. */
const ENCODER_BINDING =
  /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Schema\.encodeSync\(\s*Schema\.fromJsonString\(/

/** The encoded value being compared, right where it is produced. */
const COMPARED = /(?:===|!==|\.has\(|\.get\()/

export const findIdentityEncodes = (
  file: string,
  text: string,
): ReadonlyArray<IdentityEncodeFinding> => {
  if (!SHIPPED_SOURCE.test(file)) return []
  if (file.endsWith("core-identity-encode.ts")) return []

  const lines = text.split("\n")
  const encoders: string[] = []
  for (const line of lines) {
    const binding = Option.fromNullishOr(ENCODER_BINDING.exec(line))
    if (Option.isNone(binding)) continue
    const name = Option.getOrElse(Option.fromNullishOr(binding.value[1]), () => "")
    if (name.length > 0) encoders.push(name)
  }
  if (encoders.length === 0) return []

  const findings: IdentityEncodeFinding[] = []
  const callPattern = new RegExp(`\\b(${encoders.join("|")})\\(`)
  for (const [index, line] of lines.entries()) {
    const call = Option.fromNullishOr(callPattern.exec(line))
    if (Option.isNone(call)) continue
    const name = Option.getOrElse(Option.fromNullishOr(call.value[1]), () => "")
    // The binding itself is a declaration, not a use.
    if (ENCODER_BINDING.test(line)) continue
    if (!COMPARED.test(line) && !IDENTITY_NAMES.test(line)) continue
    findings.push({
      file,
      line: index + 1,
      message: `\`${name}\` encodes a whole object and the result decides identity on this line; JSON carries key order, so two spellings of one value compare unequal -- name the compared fields in a fixed order instead`,
    })
  }
  return findings
}
