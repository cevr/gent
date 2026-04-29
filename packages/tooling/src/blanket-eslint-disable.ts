export interface BlanketDisableFinding {
  readonly file: string
  readonly line: number
}

export const blanketDisableDirective =
  /(?:\/\*\s*eslint-disable(?:-next-line|-line)?\s*(?:\*\/|--|$))|(?:\/\/\s*eslint-disable(?:-next-line|-line)?\s*(?:--|$))/

export const findBlanketEslintDisables = (
  file: string,
  text: string,
): ReadonlyArray<BlanketDisableFinding> => {
  const findings: BlanketDisableFinding[] = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    if (blanketDisableDirective.test(lines[index] ?? "")) {
      findings.push({ file, line: index + 1 })
    }
  }
  return findings
}
