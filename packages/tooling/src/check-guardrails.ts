import { findBannedEslintDisableBlocks, findBlanketEslintDisables } from "./blanket-eslint-disable"
import {
  findCorePublicExportFindings,
  findExtensionsPublicExportFindings,
} from "./core-public-exports"
import { findPlatformDuplicationViolations } from "./platform-duplication-guards"
import { findSuppressionInventoryFindings } from "./suppression-inventory"

const trackedFiles = (await Bun.$`git ls-files --cached --others --exclude-standard`.text())
  .split("\n")
  .filter((file) => file.length > 0)

const textFiles = await Promise.all(
  trackedFiles
    .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file))
    .filter((file) => !file.includes("/dist/"))
    .map(async (file) => {
      const source = Bun.file(file)
      if (!(await source.exists())) return undefined
      return { file, text: await source.text() }
    }),
)

const failures: string[] = []
const pushFailure = (message: string): void => {
  if (!failures.includes(message)) failures.push(message)
}

for (const entry of textFiles) {
  if (entry === undefined) continue
  const { file, text } = entry

  for (const finding of [
    ...findBlanketEslintDisables(file, text),
    ...findBannedEslintDisableBlocks(file, text),
  ]) {
    pushFailure(
      `${finding.file}:${finding.line}: blanket eslint-disable comments and block eslint-disable comments are banned; use line-local suppressions with exact rules`,
    )
  }

  for (const finding of findSuppressionInventoryFindings(file, text)) {
    pushFailure(`${finding.file}:${finding.line}: unreviewed suppression ${finding.kind}`)
  }

  if (/\.[cm]?[jt]sx?$/.test(file)) {
    for (const finding of findPlatformDuplicationViolations(file, text)) {
      pushFailure(`${finding.file}:${finding.line}: ${finding.message}`)
    }
  }
}

const packageJson = await Bun.file("packages/core/package.json").json()
const tsconfigJson = await Bun.file("tsconfig.json").json()
const coreInternalPackageJson = await Bun.file("packages/core-internal/package.json").json()
const extensionsPackageJson = await Bun.file("packages/extensions/package.json").json()

for (const finding of [
  ...findCorePublicExportFindings(packageJson, tsconfigJson, coreInternalPackageJson),
  ...findExtensionsPublicExportFindings(extensionsPackageJson, tsconfigJson),
]) {
  pushFailure(`${finding.path}: ${finding.message}`)
}

if (failures.length > 0) {
  console.error("Gent guardrails failed:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
