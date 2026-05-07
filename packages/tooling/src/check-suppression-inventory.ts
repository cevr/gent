import { findSuppressionInventoryFindings } from "./suppression-inventory"

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

const failures = files.flatMap((entry) =>
  entry === undefined ? [] : findSuppressionInventoryFindings(entry.file, entry.text),
)

if (failures.length > 0) {
  console.error("Unreviewed suppression escape hatches are banned:")
  for (const failure of failures) {
    console.error(`  ${failure.file}:${failure.line} ${failure.kind}`)
  }
  process.exit(1)
}
