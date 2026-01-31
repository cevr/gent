import { SyntaxStyle } from "@opentui/core"
import type { Theme } from "./types"

export function buildSyntaxStyle(theme: Theme): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    {
      scope: ["comment", "comment.documentation"],
      style: { foreground: theme.syntaxComment, italic: true },
    },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.function", "function.method"], style: { foreground: theme.syntaxFunction } },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true, italic: true } },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: { foreground: theme.syntaxOperator },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: { foreground: theme.syntaxVariable },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: { foreground: theme.syntaxFunction },
    },
    { scope: ["type", "module", "class"], style: { foreground: theme.syntaxType } },
    { scope: ["constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["property", "parameter"], style: { foreground: theme.syntaxVariable } },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: { foreground: theme.syntaxPunctuation },
    },
    // Markdown-specific
    {
      scope: [
        "markup.heading",
        "markup.heading.1",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
      ],
      style: { foreground: theme.markdownHeading, bold: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: theme.markdownStrong, bold: true },
    },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
    {
      scope: ["markup.raw.inline"],
      style: { foreground: theme.markdownCode, background: theme.background },
    },
    {
      scope: ["markup.link", "markup.link.url"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    {
      scope: ["markup.link.label"],
      style: { foreground: theme.markdownLinkText, underline: true },
    },
    { scope: ["conceal"], style: { foreground: theme.textMuted } },
    { scope: ["spell", "nospell"], style: { foreground: theme.text } },
  ])
}
