import { findBlanketEslintDisables } from "./blanket-eslint-disable"

const trackedFiles = (await Bun.$`git ls-files --cached --others --exclude-standard`.text())
  .split("\n")
  .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file))
  .filter((file) => !file.includes("/dist/"))

const files = await Promise.all(
  trackedFiles.map(async (file) => ({
    file,
    text: await Bun.file(file).text(),
  })),
)

const failures: string[] = []

for (const { file, text } of files) {
  for (const finding of findBlanketEslintDisables(file, text)) {
    failures.push(`${finding.file}:${finding.line}`)
  }
}

if (failures.length > 0) {
  console.error("Blanket eslint-disable comments are banned. Name the exact rule instead:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
