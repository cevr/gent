/**
 * Guard: core must not name the features built on top of it.
 *
 * Core is the loop. A feature such as the code cell is an extension of the
 * loop, so core carries it through agnostic seams -- `BranchToolLayer`,
 * `InnerOperationReceipts`, `ToolCallRecoveryService` -- and never imports it.
 *
 * The runtime itself names no feature: it takes a `BranchToolFeature` as
 * input. Only composition roots are exempt -- `apps/server` lives outside
 * core, and the test-utils harnesses assemble the same stack for tests.
 *
 * @module
 */

import { Option } from "effect"

/** A core source file that imports a feature directory it must not know about. */
export interface FeatureIndependenceFinding {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** Feature directories under `packages/core/src` that core proper must not import. */
export const FEATURE_DIRECTORIES: ReadonlyArray<string> = ["code-cell"]

/**
 * SQL table-name prefixes owned by a feature.
 *
 * Core's migration chain builds the kernel's tables. A feature contributes the
 * migrations for its own tables at the same seam it contributes its
 * repositories, so a core source file naming one of these is core reaching
 * back into a feature it should not know about.
 */
export const FEATURE_TABLE_PREFIXES: ReadonlyArray<string> = ["cell_"]

/**
 * Files allowed to import a feature: composition roots, whose job is naming
 * what the runtime they build ships. Every one is a harness that assembles a
 * whole application; no file in the runtime proper belongs here.
 */
export const ASSEMBLY_SITES: ReadonlyArray<string> = [
  "packages/core/src/test-utils/e2e-layer.ts",
  "packages/core/src/test-utils/extension-harness.ts",
  "packages/core/src/test-utils/in-process-layer.ts",
]

const CORE_SRC_PREFIX = "packages/core/src/"

const IMPORT_PATTERN = /^\s*(?:import|export)\b[^"']*from\s*["']([^"']+)["']/

/** A feature-owned table named as a SQL identifier, not merely as a substring. */
const TABLE_PATTERN = (prefix: string) => new RegExp(`\\b${prefix}[a-z_]+\\b`)

/**
 * Find every import in `file` that reaches into a feature directory it is not
 * allowed to know about.
 *
 * Returns nothing for files outside core, for a feature's own sources, and for
 * the assembly sites.
 */
export const findCoreFeatureIndependenceFindings = (
  file: string,
  text: string,
): ReadonlyArray<FeatureIndependenceFinding> => {
  if (!file.startsWith(CORE_SRC_PREFIX)) return []
  if (ASSEMBLY_SITES.includes(file)) return []
  const ownSegments = file.slice(CORE_SRC_PREFIX.length).split("/")
  if (FEATURE_DIRECTORIES.some((feature) => ownSegments.includes(feature))) return []

  const findings: Array<FeatureIndependenceFinding> = []
  for (const [index, line] of text.split("\n").entries()) {
    const specifier = Option.flatMap(Option.fromNullishOr(IMPORT_PATTERN.exec(line)), (match) =>
      Option.fromNullishOr(match[1]),
    )
    if (Option.isNone(specifier)) continue
    const segments = specifier.value.split("/")
    const named = Option.fromNullishOr(
      FEATURE_DIRECTORIES.find((feature) => segments.includes(feature)),
    )
    if (Option.isNone(named)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core must not import the "${named.value}" feature (${specifier.value}); carry it through an agnostic seam, or add this file to ASSEMBLY_SITES if it assembles an application`,
    })
  }

  for (const [index, line] of text.split("\n").entries()) {
    const table = Option.fromNullishOr(
      FEATURE_TABLE_PREFIXES.find((prefix) => TABLE_PATTERN(prefix).test(line)),
    )
    if (Option.isNone(table)) continue
    findings.push({
      file,
      line: index + 1,
      message: `core must not name a "${table.value}" table; the feature that owns it contributes its own migrations through the storage assembler's feature-migrations seam`,
    })
  }
  return findings
}
