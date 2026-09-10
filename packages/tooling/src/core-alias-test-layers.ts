/**
 * Guard: a `static Test` layer must be a real alternative implementation.
 *
 * CLAUDE.md: "add a `Test` layer only when there is a real alternative
 * implementation worth a Tag." A `Test` that returns `Live` is the same layer
 * under a second name -- it adds a seam with nothing behind it, and a reader
 * has to open the file to learn that the two are identical.
 *
 * @module
 */

import { Option } from "effect"

/** A `static Test` that is an alias of the same service's `Live`. */
export interface AliasTestLayerFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

const SRC_PREFIX = "packages/"

/**
 * `static Test = (...): Layer.Layer<X> => X.Live` on one line, in any of the
 * spellings the codebase uses. Deliberately narrow: only an outright alias is
 * reported, never a `Test` that builds something.
 */
const ALIAS_TEST_PATTERN = /static\s+Test\s*=[^=]*=>\s*([A-Za-z_$][\w$]*)\.Live\s*$/

/** Report `static Test` layers that merely return `Live`. */
export const findAliasTestLayers = (
  file: string,
  text: string,
): ReadonlyArray<AliasTestLayerFinding> => {
  if (!file.startsWith(SRC_PREFIX)) return []
  if (!/\/src\//.test(file)) return []

  const findings: AliasTestLayerFinding[] = []
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const match = Option.fromNullishOr(ALIAS_TEST_PATTERN.exec(line.trimEnd()))
    if (Option.isNone(match)) continue
    const service = match.value[1]
    findings.push({
      file,
      line: index + 1,
      message: `\`static Test\` returns \`${service}.Live\` unchanged; a Test layer earns a Tag only when it is a real alternative implementation -- delete it and let callers use \`Live\``,
    })
  }
  return findings
}
