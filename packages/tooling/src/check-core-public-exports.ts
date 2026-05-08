import {
  findCorePublicExportFindings,
  findExtensionsPublicExportFindings,
} from "./core-public-exports"

const packageJson = await Bun.file("packages/core/package.json").json()
const tsconfigJson = await Bun.file("tsconfig.json").json()
const coreInternalPackageJson = await Bun.file("packages/core-internal/package.json").json()
const extensionsPackageJson = await Bun.file("packages/extensions/package.json").json()
const findings = [
  ...findCorePublicExportFindings(packageJson, tsconfigJson, coreInternalPackageJson),
  ...findExtensionsPublicExportFindings(extensionsPackageJson, tsconfigJson),
]

if (findings.length > 0) {
  console.error("Public export guard failed:")
  for (const finding of findings) {
    console.error(`  ${finding.path}: ${finding.message}`)
  }
  process.exit(1)
}
