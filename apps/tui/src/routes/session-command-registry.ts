import { createEffect, onCleanup, type Accessor } from "solid-js"
import { Effect } from "effect"
import type { ClientContextValue } from "../client/index"
import type { Command } from "../command/types"
import type { AutocompleteContribution } from "../extensions/client-facets.js"
import { formatError } from "../utils/format-error"

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
  readonly openSessionTree: () => void
  readonly openForkPicker: () => void
  readonly openPermissions: () => void
  readonly openAuth: () => void
}

const VALID_REASONING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const
type ReasoningLevelInput = (typeof VALID_REASONING_LEVELS)[number]

const parseReasoningLevel = (level: string): ReasoningLevelInput | undefined => {
  switch (level) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return level
  }
}

const slashAutocompleteItems = (
  commands: readonly Command[],
  filter: string,
): Array<{ id: string; label: string; description?: string }> => {
  const lowerFilter = filter.toLowerCase()
  const hasFilter = lowerFilter.length > 0
  const items: Array<{ id: string; label: string; description?: string }> = []
  for (const command of commands) {
    if (command.slash === undefined) continue
    if (
      !hasFilter ||
      command.slash.toLowerCase().includes(lowerFilter) ||
      command.title.toLowerCase().includes(lowerFilter)
    ) {
      items.push({
        id: command.slash,
        label: `/${command.slash}`,
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
    id: "session.tree",
    title: "Browse Branch Tree",
    category: "Session",
    slash: "tree",
    slashPriority: 0,
    onSelect: props.openSessionTree,
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
    category: "Session",
    slash: "think",
    slashPriority: 0,
    onSelect: () => {
      props.client.setError(`Usage: /think <${VALID_REASONING_LEVELS.join("|")}>`)
    },
    onSlash: (args) => {
      const level = args.trim().toLowerCase()
      const reasoningLevel = parseReasoningLevel(level)
      if (reasoningLevel === undefined) {
        props.client.setError(`Usage: /think <${VALID_REASONING_LEVELS.join("|")}>`)
        return
      }
      props.cast(
        props.client
          .updateSessionReasoningLevel(reasoningLevel === "off" ? undefined : reasoningLevel)
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
  let unsubExtCommands: (() => void) | undefined

  createEffect(() => {
    unsubExtCommands?.()
    const cmds = props.ext.commands()
    if (cmds.length > 0) {
      unsubExtCommands = props.command.register([...cmds])
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
    unsubExtCommands?.()
    props.ext.setDynamicAutocomplete([])
  })
}
