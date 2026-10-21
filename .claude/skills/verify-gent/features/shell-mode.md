# Shell mode

A user runs a shell command without leaving gent. `!` as the first character turns the composer into a `$` prompt; enter runs the command in the workspace, draws its output under it (`[exit <n>]` when it fails), and sends the command and its output to the model as the user's message.

## Sub-features

- `shell-prompt`: `!` shows `┃ $` in the composer.
- `shell-run`: `echo first-$((1+1))` draws `first-2`, then the model answers.
- `shell-exit`: `exit 3` draws `[exit 3]`.
- `shell-to-model`: the user message the model reads is `$ <command> <output>`.

## How to get to it (user POV)

- `!` as the first character of the composer, in any session.

## Driving it with verify:drive

- **Preconditions:** the baseline; a new session (`["gent"]`).
- **States:** default, error (a non-zero exit). Open, loading and empty are `n/a`.
- **Regression:** `packages/e2e/tests/e2e.test.ts` (`! runs shell commands one after another and shows each output`).

Script `drives/shell-mode.json`:

1. **Prompt.** `send !`, `cap 51-shell-prompt`. The composer reads `┃ $`.
2. **Run.** `send echo first-$((1+1))`, `keys enter`, `waitFor first-2`, `waitFor ✻ Worked for`, `cap 52-shell-ran`.
3. **Failure.** `send !`, `send exit 3`, `keys enter`, `waitFor` a second `✻ Worked for`, `capAll 53-shell-failed`. `[exit 3]` under the command.
4. **Second view.** `sh gent ctl events --tags MessageReceived --limit 6`. The user messages read `$ echo first-$((1+1)) first-2` and `$ exit 3 [exit 3]`.

## Gotchas

- Shell mode lasts one command: send `!` again before the next one.
- The second wait needs a pattern that two `Worked for` rows match (`✻ Worked for[^\n]*\n[\s\S]*✻ Worked for`); one `Worked for` already shows after the first command.
- The command runs for real in `$RUN/work`. Keep it inside the workspace.
