import { Option } from "effect"

interface PackageJson {
  readonly private?: boolean
  readonly exports?: Readonly<Record<string, string>>
}

interface TsConfigJson {
  readonly compilerOptions?: {
    readonly paths?: Readonly<Record<string, ReadonlyArray<string>>>
  }
}

export interface CorePublicSurfaceFinding {
  readonly path: string
  readonly message: string
}

export interface ExtensionsPublicSurfaceFinding {
  readonly path: string
  readonly message: string
}

export interface SdkPublicSurfaceFinding {
  readonly path: string
  readonly message: string
}

/**
 * Core's public entry points. Two authoring surfaces, deliberately split:
 * `extensions/api` for extensions that use the loop, `extensions/branch-tools`
 * for the rarer feature that implements a loop seam. Keeping them apart is
 * what keeps `api` small -- nothing in `branch-tools` belongs in an ordinary
 * extension's vocabulary.
 */
const publicCoreExports = new Set([
  "./extensions/api",
  "./extensions/api.js",
  "./extensions/branch-tools",
  "./extensions/branch-tools.js",
  "./protocol",
  "./protocol.js",
])

const isPublicCorePath = (key: string): boolean =>
  key.startsWith("@gent/core/") && publicCoreExports.has(`./${key.slice("@gent/core/".length)}`)

export const findCorePublicExportFindings = (
  packageJson: PackageJson,
  tsconfigJson: TsConfigJson,
  coreInternalPackageJson: Option.Option<PackageJson>,
): ReadonlyArray<CorePublicSurfaceFinding> => {
  const findings: CorePublicSurfaceFinding[] = []
  const exportsMap = Option.getOrElse(Option.fromNullishOr(packageJson.exports), () => ({}))
  for (const key of Object.keys(exportsMap)) {
    if (publicCoreExports.has(key)) continue
    findings.push({
      path: `packages/core/package.json exports["${key}"]`,
      message: "Core exports must name a supported extension or protocol entry point",
    })
  }

  const paths = Option.getOrElse(
    Option.flatMap(Option.fromNullishOr(tsconfigJson.compilerOptions), (options) =>
      Option.fromNullishOr(options.paths),
    ),
    () => ({}),
  )
  for (const key of Object.keys(paths)) {
    if (isPublicCorePath(key)) continue
    if (key.startsWith("@gent/core-internal/")) continue
    if (!key.startsWith("@gent/core/")) continue
    findings.push({
      path: `tsconfig.json compilerOptions.paths["${key}"]`,
      message: "Do not give TypeScript a public-looking @gent/core/* path for internal modules",
    })
  }

  if (Option.isSome(coreInternalPackageJson)) {
    const internalPackage = coreInternalPackageJson.value
    if (internalPackage.private !== true) {
      findings.push({
        path: "packages/core-internal/package.json private",
        message: "@gent/core-internal must stay private; it is not an extension author API",
      })
    }

    const internalExports = Option.getOrElse(
      Option.fromNullishOr(internalPackage.exports),
      () => ({}),
    )
    if (internalExports["./*.js"] !== "./src/*.ts" || internalExports["./*"] !== "./src/*.ts") {
      findings.push({
        path: "packages/core-internal/package.json exports",
        message:
          "@gent/core-internal should only mirror core source through the private wildcard lane",
      })
    }
  }

  return findings
}

const publicExtensionsExports = new Set([".", "./index.js", "./client", "./client.js"])
const publicExtensionsPaths = new Set([
  "@gent/extensions",
  "@gent/extensions/index.js",
  "@gent/extensions/client",
  "@gent/extensions/client.js",
])

export const findExtensionsPublicExportFindings = (
  packageJson: PackageJson,
  tsconfigJson: TsConfigJson,
): ReadonlyArray<ExtensionsPublicSurfaceFinding> => {
  const findings: ExtensionsPublicSurfaceFinding[] = []

  if (packageJson.private !== true) {
    findings.push({
      path: "packages/extensions/package.json private",
      message:
        "@gent/extensions is the builtin composition package; publish only root/client contracts",
    })
  }

  const exportsMap = packageJson.exports ?? {}
  for (const key of Object.keys(exportsMap)) {
    if (publicExtensionsExports.has(key)) continue
    findings.push({
      path: `packages/extensions/package.json exports["${key}"]`,
      message:
        "@gent/extensions may only expose root composition and ./client; use relative source imports for internal extension tests",
    })
  }

  const paths = tsconfigJson.compilerOptions?.paths ?? {}
  for (const key of Object.keys(paths)) {
    if (!key.startsWith("@gent/extensions/")) continue
    if (publicExtensionsPaths.has(key)) continue
    findings.push({
      path: `tsconfig.json compilerOptions.paths["${key}"]`,
      message:
        "Do not create public-looking @gent/extensions/* aliases for extension implementation internals",
    })
  }

  return findings
}

export const findSdkPublicExportFindings = (
  packageJson: PackageJson,
): ReadonlyArray<SdkPublicSurfaceFinding> => {
  const findings: SdkPublicSurfaceFinding[] = []
  const exportsMap = packageJson.exports ?? {}
  for (const key of Object.keys(exportsMap)) {
    if (key === ".") continue
    findings.push({
      path: `packages/sdk/package.json exports["${key}"]`,
      message: "@gent/sdk may only expose the stable root client contract",
    })
  }
  return findings
}
