# Commands

A user finds every action from the keyboard: `/` in an empty composer opens the `Commands` popup of slash commands, filtered as they type; `ctrl+p` opens the command palette, `Commands <n> [All]`, with categories a user cycles with tab. Enter runs the selected row; esc closes.

## Sub-features

- `slash-popup`: `/` opens `Commands` with `/help`, `/new`, `/branch` …; the footer reads `↑↓ move · enter select · tab complete · esc close`.
- `slash-filter`: typed text filters the popup (`/he` leaves `/help` and `/thread`).
- `palette`: `ctrl+p` opens `Commands 28 [All]  Appearance  Session  Driver  Workflow  Tools`.
- `palette-filter`: typed text filters the palette (`branch` leaves `Create Branch`, `Branches`, `Git`, `Sessions`).
- `palette-category`: tab moves to the next category (`Commands 2 [Appearance]`: `Theme`, `Mode`).
- `new-session`: `/new` (alias `/clear`) opens a new session.
- `narrow`: both lists fit at 60x20; the category row ends `…`.

## How to get to it (user POV)

- `/` as the first character of the composer.
- `ctrl+p` anywhere the composer has focus (row 1 says so).
- A command row in the palette runs the same action as its slash command.

## Driving it with verify:drive

- **Preconditions:** the baseline; a new session (`["gent"]`).
- **States:** default, open, empty (`No matches`), narrow. Loading and error are `n/a`.
- **Regression:** `packages/e2e/tests/e2e.test.ts` (`/ prefix shows the commands popup, and ESC closes it`), `apps/tui/tests/commands.test.tsx`.

Script `drives/commands.json`:

1. **Popup.** `send /`, `waitFor esc close`, `cap 31-slash-popup`. `Commands` lists the slash commands.
2. **Filter.** `send he`, `waitFor /help`, `cap 32-slash-filtered`.
3. **Close and clear.** `keys esc`, three `keys backspace`, `cap 33-composer-cleared`. The composer is empty.
4. **Palette.** `keys ctrl+p`, `waitFor Commands \d+ \[All\]`, `cap 34-palette`.
5. **Palette filter.** `send branch`, `waitFor › branch`, `cap 35-palette-filtered`. Four rows, `Create Branch` first.
6. **Category.** `keys esc` (clears the filter), `keys tab`, `waitFor Commands \d+ \[Appearance\]`, `cap 36-palette-category`.
7. **Close.** `keys esc`, `cap 37-palette-closed`. The composer has focus again.
8. **New session.** `send /new`, `keys enter`, `cap 38-new-session`. The status row reads `ready · work`.
9. **Narrow.** `resize 60 20`, then the popup (`cap 39-slash-narrow`) and the palette (`cap 40-palette-narrow`).

## Gotchas

- Esc closes the slash popup but leaves the typed text in the composer, and `ctrl+u` does not clear it: send one `backspace` per character.
- Esc on a filtered list clears the filter first; a second esc closes it.
- An esc followed at once by another key reads as alt+that key: an esc then tab kept the filter and the category. Every script puts `settle 300` after `keys esc`.
- A filter applies inside the current category: `branch` under `[Appearance]` shows `Commands 0` and `No matches`.
- Type a slash command, `settle 300`, then `keys enter`: an enter that comes before the popup filters runs nothing.
