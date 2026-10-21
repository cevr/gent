# Input, keys and commands

## Command Palette

- `Ctrl+P` or `/help` opens palette
- One `Command` shape (`id`, `title`, `category`, optional `keybind`, `slash`, `aliases`, `onSelect`, `onSlash`) and one resolved list, `useExtensionUI().commands()`. The palette search matches a command's title, its slash name and aliases, its description and its category, so `frecency` finds "Reset Autocomplete Ranking". One leading "/" in the query is dropped, so `/clear` finds "New Session" as `clear` does
- A keybind with no ctrl or meta (a bare key such as `left`) is a key the composer also reads, so it fires only while the composer is idle: an empty draft in editing mode, no overlay or docked pane, no interaction, the transcript collapsed (`composerIdle` in `session.tsx`). Any extension can bind one to a key that types nothing (an arrow, a function key). A bare key that types a character (`j`, `?`, `shift+j`, `space`) would take the first character of every message: `resolveCommands` refuses that keybind in every scope and lists it with the failed extensions; the command keeps its slash and palette row. A bare `escape` and a `ctrl+c` (with or without shift) are refused the same way (`REFUSED_KEYBINDS` in `loader-boundary.ts`): keybinds run before the Esc and ctrl+c ladders, so either would take the pane close, the turn cancel and the exit. `←` opens the agents pane this way; in the pane `←` or Esc closes it and `→` or Enter switches to the row, as `←`/`→` move between palette levels
- `resolveCommands` merges the session's own commands (`setSessionCommands`, builtin scope), client extension commands, and server slash commands (builtin scope). Precedence is project > user > builtin; a higher scope takes a slash or keybind from the earlier owner, and a same-scope claim is dropped and listed with the failed extensions

## Keys: the exit and cancel ladder

One ladder, owned by `createSessionController` (`handleEscape`, `handleInterrupt` in `session.tsx`). Esc never quits.

- **Esc** clears a list's filter before leaving the list. On a sign-in screen it goes back to the provider's methods, then the provider list. In the session it closes the palette, collapses the expanded transcript, collapses the disclosure, then cancels a running turn. On a draft the first press arms and the status row says `esc again to clear`; the second clears the draft. On an empty idle composer it stops the first active extension stoppable (`stoppableContribution`, highest scope first), such as a pending auto-resume, and otherwise does nothing. In shell mode a draft arms and clears the same way; on an empty shell draft the composer takes Esc and leaves shell mode.
- **ctrl+c** closes a pane that holds the composer, closes the palette, collapses the expanded transcript, clears a draft, stops a running `!cmd` (and arms nothing), then cancels a running turn. A press that cancels a turn, or one on an idle empty composer, arms the exit and the status row says `ctrl+c again to exit`; the second press exits, even over a turn that started since (children that keep waking the session).
- **ctrl+w**, **alt+backspace**, **ctrl+backspace** and **ctrl+u** in a list's filter, on an extension's ask line (the `/btw` pane) and on the sign-in key line delete the last word (the first three) and the whole line, as they do in the composer. They take their edit keys from `eraseKey` and `lineEdit` (`ui.tsx`, `lineEdit` exported to client extensions).
- **ctrl+d** on an empty composer exits (no pane, palette or ask open, the transcript collapsed); on a draft it deletes forward.
- An armed key disarms on any other key (the other ladder key included: an Esc that leaves shell mode disarms a ctrl+c), a paste, a keybind, or after one second (a fiber on the client runtime, so a test clock moves it; the view interrupts it when it unmounts). The arm is per key: a ctrl+c then an Esc is two gestures.
- Over the boot branch picker and an enforced sign-in, Esc does nothing and the hint says `ctrl+c quit`; ctrl+c arms the exit as on an empty composer, and the second press exits.

## Clipboard

Every copy goes through `useClipboard` (`terminal.tsx`); do not add a second copy path. It writes OSC 52 with `renderer.copyToClipboardOSC52`: plain, which herdr, mosh (the `c` selector, at most 16 KiB of base64) and a local terminal take, even over ssh; OpenTUI wraps it in DCS for tmux and screen. tmux's defaults drop both forms, so inside tmux (`TMUX` set) it also runs `tmux load-buffer -w -`, as Codex does.

Who owns the mouse decides who copies a selection. In the split footer (the session view) `renderer.useMouse` is off: the terminal, or a multiplexer such as herdr or tmux, selects and copies itself. The expanded transcript, the palette and every overlay that holds the composer (`overlayHoldsComposer`: the sign-in pane, the model and branch pickers) turn it on, so OpenTUI draws the selection and the terminal never sees the drag. There `useCopyOnSelect` (mounted once in `AppContent`) copies a finished, non-empty selection. The sign-in pane also copies its URL whole on `ctrl+y` (a non-printing key, so a code typed by hand keeps every letter); its note row says the URL was copied when tmux took it (inside tmux, where a sent OSC 52 proves nothing) or OSC 52 was sent (outside tmux), and otherwise "Could not reach the clipboard — select the URL instead". A test reads the bytes by rendering with `output: new TerminalOutput()` (`render-harness-boundary.tsx`).

## Input Prefixes

Special prefixes at input start trigger different modes:

| Prefix | Behavior                                      |
| ------ | --------------------------------------------- |
| `!`    | Shell mode - prompt changes to `$`, ESC exits |
| `$`    | Skills popup (scans ~/.claude/skills, etc.)   |
| `@`    | File finder popup, supports `@file.ts#10-20`  |
| `/`    | Command popup (/new, /agents, etc.)           |

### Shell Mode

- Type `!` at cursor position 0 → enters shell mode (prompt: `$`)
- Submit executes command, output shown in chat
- ESC at an empty shell draft, or Backspace at the draft's start (it stands for deleting the `!`), exits shell mode; Backspace elsewhere edits the command; ESC on a shell draft arms its clear (see Keys)
- Runs in the session's cwd; a spawn failure (the cwd is gone) is a refused submission (below)
- Has no time limit: while it runs the activity row shows `$ cmd`, and ctrl+c stops it (or the view going). A stopped command sends nothing, and the status row says so
- Output is read as it arrives, up to 8 MiB (`SHELL_READ_CAP_BYTES` in `composer.tsx`); past that the command is ended. The message keeps the lines that fit the `@file` cap; a cut writes the output read to `<data dir>/shell-output/` and the message names the file
- A command that exits with a status other than zero ends its message with `[exit N]`, so a failure that prints nothing still reads as one

### Refused submissions

- A submit leaves the composer before it is sent. A send the server refuses, a `!cmd` that cannot spawn, or a `/command` still waiting for the command sources when the view goes, comes back to the draft of the branch it was sent from, with its reason (`ComposerRefusals` in `session.tsx`)
- A `!cmd` that ran but whose output the server refused comes back as that output, a plain message, and the reason says the command ran. Enter sends the output; it never runs the command again. Once back it is an ordinary draft: an `@path` in it expands on that send, as in any draft
- A refused message as large as a paste (`isLargePaste`) comes back into the composer on screen as a paste placeholder; a kept draft of a branch the reader left holds the text itself, and a kept block that joins a composer on screen is written the same way. A refused command always comes back as its text, so the reader sees the command Enter would run
- A lost connection is not a refusal: the send may have landed. It retries four times under its first request id (`SEND_RETRY` in `utils.ts`, shared with the startup prompt and the headless send's predicate), and the text comes back only after the last try. That text keeps the request id: Enter on it unchanged sends it under the same id, so the server's dedup runs it once. An edited text, a draft that joins several refused texts, or a text the server answered goes under a new id. The `-p` startup prompt is a submission too: it is sent once, and a failed send comes back to the draft of its branch with its reason
- None is lost: refused texts come back in send order, ahead of what the reader has typed since. A draft of refused commands only stays in shell mode; a mixed draft writes each command with its `!`
- A refusal for a session the reader has left waits there: its text joins that branch's kept draft, and its reason (`client.setErrorIn`) shows when the reader returns. The session in view shows neither. A reason for the session in view shows at once. The reason stands while its restored draft stays unchanged; an edit dismisses that reason and keeps a newer error. Until then, each snapshot (a return, a switch, or a feed that hydrates after a reconnect) shows the held reason again. A later error or a turn start replaces it. A turn that started while the connection was down arrives only inside a snapshot; the held reason remembers how many turns the branch had started when it showed, and a snapshot that counts more drops it. An error on screen never stops a running turn: the client keeps whether a turn runs apart from the error it shows, so Esc, Ctrl+C and an interjection act on the turn while an error shows

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit,
resolved against the session's cwd. A path with whitespace or `#` is written
quoted, `@"my notes.md"#10-20`, and the popup inserts it that way. Punctuation
after a bare reference (`see @a.ts, then`) stays in the sentence. A file is cut
at 2000 lines or 50 KB of UTF-8, counted by the core line rule.

### Slash Commands

| Command            | Action                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `/new`, `/clear`   | Start a new session                                                                                                       |
| `/help`            | Open the command palette                                                                                                  |
| `/sessions`        | Sessions pane: one row per thread, needs you first; side threads marked; a model by the status row's name (`modelIdName`) |
| `/agents`, `/tree` | Aliases of `/sessions`                                                                                                    |
| `/branch`          | Create new branch                                                                                                         |
| `/fork`            | Fork from a message                                                                                                       |
| `/thread`          | Thread pane: the sessions and windows this one runs on                                                                    |
| `/btw`, `/side`    | Fork pane: ask a parallel session on the side; `ctrl+s` merges it back                                                    |

A command sent before every command source has answered (the client
extensions' load and the session's server slash list, `commandsSettled` in
`extensions/host.tsx`) waits for them, then resolves. Only a known command
name is a command, and the session decides which names are known. A name
the settled sources lack makes the session read the server list once more
(`refreshCommands`), since an extension can register a command after the
last listing. A first word that still names no command is refused into its
draft, `Unknown command: /zzq · ctrl+p commands`, unless it reads as a path
(a second `/` or a `.`): that line goes out as a message. A draft that starts
with a paste chip is never a command. A command still waiting when the
session view goes comes back to its draft too. The server list is read once
per session and connection and on each refresh: a listing that a dropped
connection cut short is no answer, and the reconnect reads it again.
