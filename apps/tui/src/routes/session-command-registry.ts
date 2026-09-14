import { createEffect, onCleanup, type Accessor } from "solid-js"
import { Effect, Match, Option, Schema } from "effect"
import type { ClientContextValue } from "../client/index"
import type { Command } from "../command/types"
import type { AutocompleteContribution } from "../extensions/client-facets.js"
import { formatError } from "../utils/format-error"
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
  readonly navigateToCreatedSession: Parameters<ClientContextValue["createSession"]>[0]
  readonly openForkPicker: () => void
  readonly openModelPicker: () => void
  readonly openReasoningPicker: () => void
  readonly openPermissions: () => void
  readonly openAuth: () => void
}

/** `/think <level>`: a core reasoning level, or `default`/`off` to clear the session override. */
const ReasoningLevelInput = Schema.Union([ReasoningEffort, Schema.Literals(["default", "off"])])
const VALID_REASONING_LEVELS = ["default", ...ReasoningEffort.literals]

const parseReasoningLevel = Schema.decodeUnknownOption(ReasoningLevelInput)

const AMBIGUOUS_PREVIEW = 4

export const describeAmbiguous = (query: string, candidates: readonly Model[]): string => {
  const shown: string[] = candidates.slice(0, AMBIGUOUS_PREVIEW).map((model) => model.id)
  if (candidates.length > AMBIGUOUS_PREVIEW) shown.push("…")
  return `"${query}" matches ${candidates.length} models: ${shown.join(", ")}`
}

const slashAutocompleteItems = (
  commands: readonly Command[],
  filter: string,
): Array<{ id: string; label: string; description?: string }> => {
  const lowerFilter = filter.toLowerCase()
  const hasFilter = lowerFilter.length > 0
  const items: Array<{ id: string; label: string; description?: string }> = []
  for (const command of commands) {
    const slash = Option.fromNullishOr(command.slash)
    if (Option.isNone(slash)) continue
    if (
      !hasFilter ||
      slash.value.toLowerCase().includes(lowerFilter) ||
      command.title.toLowerCase().includes(lowerFilter)
    ) {
      items.push({
        id: slash.value,
        label: `/${slash.value}`,
        description: command.description ?? command.title,
      })
    }
    if (hasFilter) {
      for (const alias of command.aliases ?? []) {
        if (alias.toLowerCase().includes(lowerFilter)) {
          items.push({
            id: alias,
            label: `/${alias}`,
            description: command.description ?? command.title,
          })
        }
      }
    }
  }
  return items
}

const createSessionBuiltins = (props: SessionCommandRegistryProps): Command[] => [
  {
    id: "session.new",
    title: "New Session",
    category: "Session",
    slash: "new",
    aliases: ["clear"],
    slashPriority: 0,
    onSelect: () => props.client.createSession(props.navigateToCreatedSession),
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
      props.cast(
        props.client.createBranch().pipe(
          Effect.asVoid,
          Effect.catchEager((error) =>
            Effect.sync(() => {
              props.client.setError(formatError(error))
            }),
          ),
        ),
      )
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
          .pipe(
            Effect.catchEager((error) =>
              Effect.sync(() => {
                props.client.setError(formatError(error))
              }),
            ),
          ),
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
            .pipe(
              Effect.catchEager((error) =>
                Effect.sync(() => {
                  props.client.setError(formatError(error))
                }),
              ),
            ),
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
    id: "session.permissions",
    title: "View/Edit Permissions",
    category: "Session",
    slash: "permissions",
    slashPriority: 0,
    onSelect: props.openPermissions,
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
        items: (filter) => slashAutocompleteItems(allCommands, filter),
      },
    ])
  })

  onCleanup(() => {
    unsubBuiltins()
    if (Option.isSome(unsubExtCommands)) unsubExtCommands.value()
    props.ext.setDynamicAutocomplete([])
  })
}
