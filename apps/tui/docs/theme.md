# Theme

Ported from opencode: its schema and token names, cut to the tokens gent draws. Key patterns:

- `renderer.getPalette({ size: 16 })` queries terminal's ANSI palette via OSC
- The mode follows the terminal: a palette read that reports the background sets it (`isLight`, Codex's `is_light`, the rule of OpenTUI's `themeMode`), in the step that sets `paletteSettled`, so history draws in that mode from its first row. `detectColorScheme` (`COLORFGBG`, then the macOS appearance, else dark) is only the first frame's guess, and the mode when the terminal reports no background; the Mode toggle sets it until the next read (SIGUSR2)
- System theme generated from terminal colors; fallback to the `fx` theme
- JSON themes in `src/themes/*.json` with `defs` + dark/light variants
- `resolveTheme(themeJson, mode, terminalBackground)` resolves refs to RGBA values. A ported theme may omit `selectedListItemText` (the background) and `backgroundPanel`; a key gent does not draw is ignored, so an opencode theme file resolves as it is.
- The palette's "Theme" level enumerates `all()`; "Mode" is the separate Dark/Light toggle.
- Every color a component draws is a token from `useTheme()` (an extension names one through `NamedThemeColor`): no hex, color name or `dim` at a call site. `gent/theme-token-colors` (`packages/tooling/src/gent-rules.ts`) rejects them in `apps/tui/src` outside `theme.tsx`.

| Token                           | Role                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text`                          | primary text: the agent's answer, the reader's text, tool bodies                                                                                                                                             |
| `textMuted`                     | secondary text: everything gent draws around the answer (run rows, notices, queue rows, status row, hints)                                                                                                   |
| `primary`                       | the reader's mark and the active control: the rail, the selection fill, focus bars                                                                                                                           |
| `info`                          | names and links: agent names, status labels                                                                                                                                                                  |
| `success` / `warning` / `error` | it worked / it needs the reader / it failed                                                                                                                                                                  |
| `selectedListItemText`          | text on a `primary` fill                                                                                                                                                                                     |
| `background`                    | the canvas; `transparent` is the terminal's own                                                                                                                                                              |
| `backgroundPanel`               | the reader's message surface. Left out or `transparent`, it is derived from the background (Codex's prompt fill: white at 12% on dark, black at 4% on light), and with no known background it is transparent |
| `border`                        | frames and elision dots                                                                                                                                                                                      |
| `diff*`, `markdown*`, `syntax*` | the diff renderer and `buildSyntaxStyle`                                                                                                                                                                     |

Contrast rule (WCAG 2.1, `theme.test.tsx` holds every bundled theme to it in both modes; a transparent background is read against black, `#1d1f21`, `#282c34`, white, `#f5f5f5` and `#fdf6e3`): every text token 4.5:1 on its background, `border` 3:1, `selectedListItemText` 4.5:1 on `primary`, each of `PANEL_TEXT_TOKENS` (`text`, `textMuted`, `info`: what `UserRow` draws) 4.5:1 on `backgroundPanel`, and `text` 1.5:1 from `textMuted`. The `system` theme is clamped at runtime by `readableOn` (Codex's bounded search); every panel, named or derived, fades toward the background until its inks read (`readablePanel`); a bundled theme's other values are fixed in its JSON.
