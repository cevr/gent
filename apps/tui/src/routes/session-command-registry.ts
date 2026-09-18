import { createEffect, onCleanup, type Accessor } from "solid-js"
import { Match, Option, Schema, type Effect } from "effect"
import type { ClientContextValue } from "../client"
import type { Command } from "../command/types"
import type { AutocompleteContribution, AutocompleteItem } from "../extensions/client-facets.js"
import { type FrecencyLookup, noFrecency, rankAutocompleteItems } from "../autocomplete"
import { resolveModelQuery, type ModelQueryResult } from "../client/model-query"
import { ReasoningEffort, type Model, type ModelId } from "@gent/core/protocol"

interface SessionCommandRegistryProps {
  readonly client: ClientContextValue
  readonly command: {
    readonly commands: Accessor<readonly Command[]>
    readonly register: (commands: Command[]) => () => void
    readonly openPalette: () => void
  }
  readonly ext: {
    readonly commands: Accessor<readonly Command[]>
    readonly setDynamicAutocomplete: (items: ReadonlyArray<AutocompleteContribution>) => void
  }
  readonly cast: <A, E>(effect: Effect.Effect<A, E, never>) => void
  /** The reader's pick history, so a command they choose often ranks first. */
  readonly frecency: () => FrecencyLookup
  /** Records that the reader chose a command from the `/` popup. */
  readonly recordPick: (id: string) => void
  /** Forgets every recorded pick, so ranking starts over. */
  readonly resetFrecency: () => void
  readonly openForkPicker: () => void
  readonly openModelPicker: () => void
  readonly openReasoningPicker: () => void
  readonly openAuth: () => void
}

/** `/think <level>`: a core reasoning level, or `default`/`off` to clear the session override. */
const ReasoningLevelInput = Schema.Union([ReasoningEffort, Schema.Literals(["default", "off"])])
const VALID_REASONING_LEVELS = ["default", ...ReasoningEffort.literals]

const parseReasoningLevel = Schema.decodeUnknownOption(ReasoningLevelInput)

const AMBIGUOUS_PREVIEW = 4

const describeAmbiguous = (query: string, candidates: readonly Model[]): string => {
  const shown: string[] = candidates.slice(0, AMBIGUOUS_PREVIEW).map((model) => model.id)
  if (candidates.length > AMBIGUOUS_PREVIEW) shown.push("…")
  return `"${query}" matches ${candidates.length} models: ${shown.join(", ")}`
}

/**
 * Every command the reader could mean, ranked best first.
 *
 * The filtering used to happen here, by asking whether the slash name or the
 * title contained the filter, and the surviving commands kept their
 * registration order. Both halves were wrong for a popup whose first row is
 * preselected: a title match counted for as much as a name match, so `/ag` led
 * with `/fork` ("Fork from Mess**ag**e"), and nothing afterwards reordered it.
 *
 * Now the list is built unfiltered — names and aliases both — and
 * {@link rankAutocompleteItems} decides what matches and in what order. It
 * scores names far above descriptions, so a command whose description happens
 * to carry the letters still appears, but never ahead of the one actually
 * named.
 *
 * `frecency` carries the reader's own pick history. Without it `/t` answers
 * `think` forever, because `think` and `thread` tie on everything but length;
 * with it, the one this reader actually opens wins. It defaults to "no
 * history", so a caller that has not loaded a store ranks exactly as before.
 */
export const slashAutocompleteItems = (
  commands: readonly Command[],
  filter: string,
  frecency: FrecencyLookup = noFrecency,
): ReadonlyArray<AutocompleteItem> => {
  const items: Array<AutocompleteItem> = []
  for (const command of commands) {
    const slash = Option.fromNullishOr(command.slash)
    if (Option.isNone(slash)) continue
    const description = command.description ?? command.title
    items.push({ id: slash.value, label: `/${slash.value}`, description })
    for (const alias of command.aliases ?? []) {
      items.push({ id: alias, label: `/${alias}`, description })
    }
  }
  return rankAutocompleteItems(items, filter, { prefix: "/", frecency })
}

const createSessionBuiltins = (props: SessionCommandRegistryProps): Command[] => [
  {
    id: "session.new",
    title: "New Session",
    category: "Session",
    slash: "new",
    aliases: ["clear"],
    slashPriority: 0,
    onSelect: () => props.client.createSession(),
  },
  {
    id: "session.frecency-reset",
    title: "Reset Autocomplete Ranking",
    description: "Forget which commands and skills you pick most (/frecency-reset)",
    category: "Session",
    slash: "frecency-reset",
    slashPriority: 0,
    onSelect: props.resetFrecency,
  },
  {
    id: "session.sessions",
    title: "Open Sessions",
    category: "Session",
    slash: "sessions",
    slashPriority: 0,
    onSelect: () => props.command.openPalette(),
  },
  {
    id: "session.branch",
    title: "Create Branch",
    category: "Session",
    slash: "branch",
    slashPriority: 0,
    onSelect: () => {
      props.cast(props.client.surfaceError(props.client.createBranch()))
    },
  },
  {
    id: "session.fork",
    title: "Fork from Message",
    category: "Session",
    slash: "fork",
    slashPriority: 0,
    onSelect: props.openForkPicker,
  },
  {
    id: "session.think",
    title: "Set Reasoning Level",
    description: "Pick the reasoning level for this session (/think <level>, /think default)",
    category: "Session",
    slash: "think",
    slashPriority: 0,
    onSelect: props.openReasoningPicker,
    onSlash: (args) => {
      const level = args.trim().toLowerCase()
      if (level.length === 0) {
        props.openReasoningPicker()
        return
      }
      const reasoningLevel = parseReasoningLevel(level)
      if (Option.isNone(reasoningLevel)) {
        props.client.setError(`Usage: /think <${VALID_REASONING_LEVELS.join("|")}>`)
        return
      }
      // `default`/`off` decode to `None`, which clears the session override.
      const sessionReasoningLevel = Option.getOrUndefined(
        Schema.decodeUnknownOption(ReasoningEffort)(reasoningLevel.value),
      )
      props.cast(
        props.client
          .updateSessionSettings((current) => ({
            ...current,
            reasoningLevel: sessionReasoningLevel,
          }))
          .pipe(props.client.surfaceError),
      )
    },
  },
  {
    id: "session.model",
    title: "Set Model",
    description: "Pick the model for this session (/model <id or name>, /model default)",
    category: "Session",
    slash: "model",
    slashPriority: 0,
    onSelect: props.openModelPicker,
    onSlash: (args) => {
      const query = args.trim()
      if (query.length === 0) {
        props.openModelPicker()
        return
      }
      const apply = (modelId: Option.Option<ModelId>) =>
        props.cast(
          props.client
            .updateSessionSettings((current) => ({
              ...current,
              modelId: Option.getOrUndefined(modelId),
            }))
            .pipe(props.client.surfaceError),
        )
      if (query === "default" || query === "off") {
        apply(Option.none())
        return
      }
      Match.type<ModelQueryResult>().pipe(
        Match.tagsExhaustive({
          Match: (result) => apply(Option.some(result.model.id)),
          None: () => props.client.setError(`No model matches "${query}"`),
          Ambiguous: (result) => props.client.setError(describeAmbiguous(query, result.candidates)),
        }),
      )(resolveModelQuery(props.client.models(), query))
    },
  },
  {
    id: "session.auth",
    title: "Manage API Keys",
    category: "Session",
    slash: "auth",
    slashPriority: 0,
    onSelect: props.openAuth,
  },
]

export const createSessionCommandRegistry = (props: SessionCommandRegistryProps): void => {
  const unsubBuiltins = props.command.register(createSessionBuiltins(props))
  let unsubExtCommands: Option.Option<() => void> = Option.none()

  createEffect(() => {
    if (Option.isSome(unsubExtCommands)) unsubExtCommands.value()
    const cmds = props.ext.commands()
    if (cmds.length > 0) {
      unsubExtCommands = Option.some(props.command.register([...cmds]))
    } else {
      unsubExtCommands = Option.none()
    }
  })

  createEffect(() => {
    const allCommands = props.command.commands()
    props.ext.setDynamicAutocomplete([
      {
        prefix: "/",
        title: "Commands",
        items: (filter) => slashAutocompleteItems(allCommands, filter, props.frecency()),
        // Without this a slash pick is never recorded, and `/t` answers
        // `think` forever however often the reader opens `/thread`.
        onSelect: (id: string) => props.recordPick(id),
      },
    ])
  })

  onCleanup(() => {
    unsubBuiltins()
    if (Option.isSome(unsubExtCommands)) unsubExtCommands.value()
    props.ext.setDynamicAutocomplete([])
  })
}
