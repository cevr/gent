import { findPlatformDuplicationViolations } from "./platform-duplication-guards"

const trackedFiles = (await Bun.$`git ls-files --cached --others --exclude-standard`.text())
  .split("\n")
  .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file))

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
  for (const finding of findPlatformDuplicationViolations(file, text)) {
    failures.push(`${finding.file}:${finding.line}: ${finding.message}`)
  }
}

if (failures.length > 0) {
  console.error("Platform duplication guard failed:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
