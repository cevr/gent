# Asks

The agent can ask a background question and keep working on an assumption. A footer row under the status row shows it (`? 1 open question · cache · assuming in-memory LRU · /answer`). `/answer` opens a docked form (`Question 1/1 · cache`) with the question, the options and an `Other` row; enter submits the selected option, and the answer joins the running turn as a message the agent reads.

## Sub-features

- `ask-row`: the footer row appears while the turn runs, with the topic and the assumption.
- `answer-form`: `/answer` opens `Which cache backend do you want in production?` with `in-memory LRU - assumed`, `Redis - shared across instances`, `SQLite`, `Other`; the footer reads `enter submit · ctrl+x dismiss · esc close`.
- `answer-submit`: down, then enter answers `Redis`; the transcript shows `↳ answered · Which cache backend do you want in production? → Redis`.
- `answer-reaches-agent`: the agent's next message quotes `Q: … You assumed: in-memory LRU` and `A: Redis`.

## How to get to it (user POV)

- `/answer` while a question is open (the footer row names it).

## Driving it with verify:drive

- **Preconditions:** the baseline; a new session (`["gent"]`). `debug ask` asks one question, then runs a 20 s bash step.
- **States:** default, open, loading (the turn runs while the form is open). Empty and error are `n/a`.
- **Regression:** `apps/tui/tests/extensions/interaction-tools.client.test.tsx`.

Script `drives/asks.json`:

1. **Ask.** `send debug ask`, `keys enter`, `waitFor 1 open question`, `cap 61-question-row`.
2. **Second view.** `sh gent ctl wait --until ToolCallSucceeded --after 0 --timeout 10`. The match is the `ask_user_async` call, text `cache · assuming in-memory LRU`.
3. **Form.** `send /answer`, `keys enter`, `waitFor Which cache backend`, `cap 62-answer-form`.
4. **Answer.** `keys down`, `keys enter`, `waitFor ✻ Worked for` (about 20 s), `capAll 63-answered`.
5. **Proof.** `sh gent ctl events --tags ToolCallSucceeded,MessageReceived --limit 12`. A user message starts `Answer to your background question`, and the last assistant message quotes `A: Redis`.

## Gotchas

- The turn takes about 20 s: give the last `waitFor` 40 s.
- The question is a file under `$RUN/data/questions`.
- On the form, esc closes it and `ctrl+x` dismisses the question, as its footer says.
