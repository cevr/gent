import { findBannedEslintDisableBlocks, findBlanketEslintDisables } from "./blanket-eslint-disable"

const trackedFiles = (await Bun.$`git ls-files --cached --others --exclude-standard`.text())
  .split("\n")
  .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file))
  .filter((file) => !file.includes("/dist/"))

const files = await Promise.all(
  trackedFiles.map(async (file) => {
    const source = Bun.file(file)
    if (!(await source.exists())) return undefined
    return {
      file,
      text: await source.text(),
    }
  }),
)

const failures: string[] = []

for (const entry of files) {
  if (entry === undefined) continue
  const { file, text } = entry
  for (const finding of [
    ...findBlanketEslintDisables(file, text),
    ...findBannedEslintDisableBlocks(file, text),
  ]) {
    const key = `${finding.file}:${finding.line}`
    if (!failures.includes(key)) failures.push(key)
  }
}

if (failures.length > 0) {
  console.error(
    "Blanket eslint-disable comments and block eslint-disable comments are banned. Use line-local suppressions with exact rules:",
  )
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
