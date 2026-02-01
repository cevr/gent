/**
 * Session route - message list, input, streaming
 */

import { createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import {
  extractText,
  extractImages,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
  type BranchTreeNode,
  useClient,
} from "../client/index"
import { StatusBar } from "../components/status-bar"
import { MessageList, type Message, type SessionItem } from "../components/message-list"
import { Indicators, type Indicator } from "../components/indicators"
import { Input } from "../components/input"
import { useTheme, buildSyntaxStyle } from "../theme/index"
import { useCommand } from "../command/index"
import { useRouter } from "../router/index"
import { executeSlashCommand } from "../commands/slash-commands"
import { useRuntime } from "../hooks/use-runtime"
import {
  InputState,
  transition,
  type InputEvent,
  type InputEffect,
} from "../components/input-state"
import { formatError, type UiError } from "../utils/format-error"
import { BranchTree } from "../components/branch-tree"
import { MessagePicker } from "../components/message-picker"
import type { SessionEvent } from "../components/session-event-indicator"

export interface SessionProps {
  sessionId: string
  branchId: string
  initialPrompt?: string
}

type OverlayState = null | { _tag: "tree"; nodes: BranchTreeNode[] } | { _tag: "fork" }

export function Session(props: SessionProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const command = useCommand()
  const client = useClient()
  const router = useRouter()
  const { cast } = useRuntime(client.client.runtime)

  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))

  const [store, setStore] = createStore<{ messages: Message[]; events: SessionEvent[] }>({
    messages: [],
    events: [],
  })
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [inputState, setInputState] = createSignal<InputState>(InputState.normal())
  const [overlay, setOverlay] = createSignal<OverlayState>(null)
  const [compacting, setCompacting] = createSignal(false)
  let initialPromptSent = false
  let eventSeq = 0

  const COMPACTION_MIN_MS = 600
  let compactionStartedAt: number | null = null
  let compactionTimer: ReturnType<typeof setTimeout> | null = null

  const startCompaction = () => {
    compactionStartedAt = Date.now()
    if (compactionTimer !== null) {
      clearTimeout(compactionTimer)
      compactionTimer = null
    }
    setCompacting(true)
  }

  const stopCompaction = () => {
    if (!compacting()) {
      compactionStartedAt = null
      return
    }

    const startedAt = compactionStartedAt ?? Date.now()
    const elapsedMs = Date.now() - startedAt
    const remainingMs = COMPACTION_MIN_MS - elapsedMs

    if (remainingMs <= 0) {
      setCompacting(false)
      compactionStartedAt = null
      return
    }

    if (compactionTimer !== null) {
      clearTimeout(compactionTimer)
    }
    compactionTimer = setTimeout(() => {
      setCompacting(false)
      compactionStartedAt = null
      compactionTimer = null
    }, remainingMs)
  }

  const items = createMemo((): SessionItem[] => {
    const combined: SessionItem[] = [...store.messages, ...store.events]
    return combined.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a._tag === "event" && b._tag === "event") return a.seq - b.seq
      if (a._tag === b._tag) return 0
      return a._tag === "message" ? -1 : 1
    })
  })

  onCleanup(() => {
    if (compactionTimer !== null) clearTimeout(compactionTimer)
  })

  const indicator = (): Indicator | null => {
    const error = client.error()
    if (error !== null) return { _tag: "error", message: error }
    if (compacting()) return { _tag: "compacting" }
    if (client.isStreaming()) return { _tag: "thinking" }
    return null
  }

  // Build messages from raw messages
  const buildMessages = (msgs: readonly MessageInfoReadonly[]): Message[] => {
    const resultMap = buildToolResultMap(msgs)
    const filteredMsgs = msgs.filter((m) => m.role !== "tool")

    return filteredMsgs.map((m) => {
      const toolCalls = extractToolCallsWithResults(m.parts, resultMap)

      return {
        _tag: "message",
        id: m.id,
        role: m.role,
        kind: m.kind ?? "regular",
        content: extractText(m.parts),
        images: extractImages(m.parts),
        createdAt: m.createdAt,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      }
    })
  }

  const loadMessages = (branchId: string) => {
    cast(
      client.client.listMessages(branchId).pipe(
        Effect.map((msgs) => buildMessages(msgs)),
        Effect.tap((msgs) =>
          Effect.sync(() => {
            setStore("messages", msgs)
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  // Load messages when session becomes active
  createEffect(() => {
    if (!client.isActive()) return

    loadMessages(props.branchId)
  })

  const sendInitialPrompt = () => {
    if (props.initialPrompt === undefined || props.initialPrompt === "" || initialPromptSent) return
    initialPromptSent = true
    cast(
      client.client
        .sendMessage({
          sessionId: props.sessionId,
          branchId: props.branchId,
          content: props.initialPrompt,
        })
        .pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              client.setError(formatError(err))
            }),
          ),
        ),
    )
  }

  // Subscribe to agent events for message updates
  createEffect(() => {
    if (!client.isActive()) return

    const unsubscribe = client.subscribeEvents((event) => {
      if (event._tag === "MessageReceived") {
        loadMessages(props.branchId)
      } else if (event._tag === "BranchSwitched") {
        if (event.toBranchId !== props.branchId) {
          setStore({ messages: [], events: [] })
          router.navigateToSession(event.sessionId, event.toBranchId)
        }
      } else if (event._tag === "StreamStarted") {
        setStore(
          produce((draft) => {
            draft.messages.push({
              _tag: "message",
              id: crypto.randomUUID(),
              role: "assistant",
              kind: "regular",
              content: "",
              images: [],
              createdAt: Date.now(),
              toolCalls: undefined,
            })
          }),
        )
      } else if (event._tag === "StreamChunk") {
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant") {
              last.content += event.chunk
            } else {
              draft.messages.push({
                _tag: "message",
                id: crypto.randomUUID(),
                role: "assistant",
                kind: "regular",
                content: event.chunk,
                images: [],
                createdAt: Date.now(),
                toolCalls: undefined,
              })
            }
          }),
        )
      } else if (event._tag === "TurnCompleted") {
        // Server is source of truth for turn completion/interruption
        const durationSeconds = Math.round(event.durationMs / 1000)
        if (event.interrupted === true) {
          setStore(
            produce((draft) => {
              draft.events.push({
                _tag: "event",
                kind: "interruption",
                createdAt: Date.now(),
                seq: eventSeq++,
              })
            }),
          )
        } else if (durationSeconds > 0) {
          setStore(
            produce((draft) => {
              draft.events.push({
                _tag: "event",
                kind: "turn-ended",
                durationSeconds,
                createdAt: Date.now(),
                seq: eventSeq++,
              })
            }),
          )
        }
      } else if (event._tag === "ToolCallStarted") {
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant") {
              if (last.toolCalls === undefined) last.toolCalls = []
              last.toolCalls.push({
                id: event.toolCallId,
                toolName: event.toolName,
                status: "running" as const,
                input: event.input,
                summary: undefined,
                output: undefined,
              })
            }
          }),
        )
      } else if (event._tag === "ToolCallCompleted") {
        setStore(
          produce((draft) => {
            const last = draft.messages[draft.messages.length - 1]
            if (last !== undefined && last.role === "assistant" && last.toolCalls !== undefined) {
              const tc = last.toolCalls.find((t) => t.id === event.toolCallId)
              if (tc !== undefined) {
                tc.status = event.isError ? "error" : "completed"
                tc.summary = event.summary
                tc.output = event.output
              }
            }
          }),
        )
      } else if (event._tag === "CompactionStarted") {
        startCompaction()
      } else if (event._tag === "CompactionCompleted") {
        stopCompaction()
        setStore(
          produce((draft) => {
            draft.events.push({
              _tag: "event",
              kind: "compaction",
              createdAt: Date.now(),
              seq: eventSeq++,
            })
          }),
        )
      } else if (event._tag === "QuestionsAsked") {
        handleInputEvent({ _tag: "QuestionsAsked", event })
      } else if (event._tag === "PermissionRequested") {
        handleInputEvent({ _tag: "PermissionRequested", event })
      } else if (event._tag === "PlanPresented") {
        handleInputEvent({ _tag: "PlanPresented", event })
      }
      // Note: agent state (status, cost, error) is updated by ClientProvider
    })

    sendInitialPrompt()

    onCleanup(unsubscribe)
  })

  const exit = () => {
    renderer.destroy()
    process.exit(0)
  }

  // Clear messages handler for /clear command
  const clearMessages = () => {
    setStore({ messages: [], events: [] })
  }

  const openBranchTree = () => {
    cast(
      client.getBranchTree().pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setOverlay({ _tag: "tree", nodes: [...tree] })
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  const openForkPicker = () => {
    if (store.messages.length === 0) {
      client.setError("No messages to fork")
      return
    }
    setOverlay({ _tag: "fork" })
  }

  // Track pending ESC for double-tap quit
  let lastEscTime = 0
  const ESC_DOUBLE_TAP_MS = 500

  useKeyboard((e) => {
    // Let command system handle keybinds first
    if (command.handleKeybind(e)) return

    if (overlay() !== null) return

    // ESC: cancel if streaming, double-tap to quit when idle
    if (e.name === "escape") {
      if (command.paletteOpen()) {
        command.closePalette()
        return
      }

      if (client.isStreaming()) {
        client.steer({ _tag: "Cancel" })
        // Status will be set to "idle" when StreamEnded event arrives
        return
      }

      const now = Date.now()
      if (now - lastEscTime < ESC_DOUBLE_TAP_MS) {
        exit()
      } else {
        lastEscTime = now
      }
      return
    }

    // Ctrl+C: always quit immediately
    if (e.ctrl === true && e.name === "c") {
      exit()
      return
    }

    // Ctrl+O: toggle tool output expansion
    if (e.ctrl === true && e.name === "o") {
      setToolsExpanded((prev) => !prev)
      return
    }
  })

  const handleSubmit = (content: string, mode?: "queue" | "interject") => {
    if (mode === "interject" && client.isStreaming()) {
      client.steer({ _tag: "Interject", message: content })
      return
    }

    client.sendMessage(content)
  }

  // Handle input state transitions
  const handleInputEvent = (event: InputEvent) => {
    const result = transition(inputState(), event)
    setInputState(result.state)
    if (result.effect !== undefined) {
      handleInputEffect(result.effect)
    }
  }

  // Handle input effects (side effects from state transitions)
  const handleInputEffect = (effect: InputEffect) => {
    switch (effect._tag) {
      case "ClearInput":
        // Input component handles this internally
        break
      case "RespondPrompt":
        if (effect.kind === "questions") {
          cast(
            client.client.respondQuestions(effect.requestId, effect.answers).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        } else if (effect.kind === "permission") {
          const { decision, persist } = pickPermissionDecision(effect.answers)
          cast(
            client.client.respondPermission(effect.requestId, decision, persist).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        } else {
          const { decision, reason } = pickPlanDecision(effect.answers)
          cast(
            client.client.respondPlan(effect.requestId, decision, reason).pipe(
              Effect.tapError((err) =>
                Effect.sync(() => {
                  client.setError(formatError(err))
                }),
              ),
            ),
          )
        }
        break
    }
  }

  const handleSlashCommand = (cmd: string, args: string): Effect.Effect<void, UiError> =>
    executeSlashCommand(cmd, args, {
      openPalette: () => command.openPalette(),
      clearMessages,
      navigateToSessions: () => command.openPalette(),
      compactHistory: Effect.gen(function* () {
        yield* Effect.sync(() => {
          startCompaction()
        })
        try {
          yield* client.compactBranch()
        } finally {
          yield* Effect.sync(() => {
            stopCompaction()
          })
        }
      }),
      createBranch: client.createBranch().pipe(Effect.asVoid),
      openTree: openBranchTree,
      openFork: openForkPicker,
      toggleBypass: Effect.gen(function* () {
        const current = client.session()?.bypass ?? true
        yield* client.updateSessionBypass(!current)
      }),
      openPermissions: () => router.navigateToPermissions(),
      openAuth: () => router.navigateToAuth(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.error !== undefined) {
            client.setError(result.error)
          }
        }),
      ),
      Effect.asVoid,
    )

  const handleBranchSelect = (branchId: string) => {
    setOverlay(null)
    client.switchBranch(branchId)
  }

  const handleForkSelect = (messageId: string) => {
    setOverlay(null)
    cast(
      client.forkBranch(messageId).pipe(
        Effect.tap((branchId) =>
          Effect.sync(() => {
            client.switchBranch(branchId)
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  }

  const overlayTree = () => {
    const current = overlay()
    return current?._tag === "tree" ? current.nodes : []
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Messages */}
      <MessageList
        items={items()}
        toolsExpanded={toolsExpanded()}
        syntaxStyle={syntaxStyle}
        streaming={client.isStreaming()}
      />

      {/* Thinking indicator */}
      <Indicators indicator={indicator()} />

      {/* Input with autocomplete above separator */}
      <Input
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        clearMessages={clearMessages}
        inputState={inputState()}
        onInputEvent={handleInputEvent}
        onInputEffect={handleInputEffect}
      >
        <Input.Autocomplete />
        {/* Separator line */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
        </box>
      </Input>

      <BranchTree
        open={overlay()?._tag === "tree"}
        tree={overlayTree()}
        activeBranchId={client.session()?.branchId}
        onSelect={handleBranchSelect}
        onClose={() => setOverlay(null)}
      />

      <MessagePicker
        open={overlay()?._tag === "fork"}
        messages={store.messages}
        onSelect={handleForkSelect}
        onClose={() => setOverlay(null)}
      />

      {/* Separator line */}
      <box flexShrink={0}>
        <text style={{ fg: theme.textMuted }}>{"─".repeat(dimensions().width)}</text>
      </box>

      {/* Status Bar */}
      <StatusBar.Root>
        <StatusBar.ErrorRow />
        <StatusBar.Row>
          <StatusBar.Agent />
        </StatusBar.Row>
        <StatusBar.Row>
          <StatusBar.Cwd />
          <StatusBar.Separator />
          <StatusBar.Git />
          <StatusBar.Separator />
          <StatusBar.Cost />
        </StatusBar.Row>
      </StatusBar.Root>
    </box>
  )
}

const pickPermissionDecision = (
  answers: readonly (readonly string[])[],
): { decision: "allow" | "deny"; persist: boolean } => {
  const selections = answers.flat().map((value) => value.trim().toLowerCase())
  if (selections.includes("always allow")) {
    return { decision: "allow", persist: true }
  }
  if (selections.includes("always deny")) {
    return { decision: "deny", persist: true }
  }
  if (selections.includes("allow")) return { decision: "allow", persist: false }
  if (selections.includes("deny")) return { decision: "deny", persist: false }
  return { decision: "deny", persist: false }
}

const pickPlanDecision = (
  answers: readonly (readonly string[])[],
): { decision: "confirm" | "reject"; reason?: string } => {
  const selections = answers.flat().map((value) => value.trim())
  const normalized = selections.map((value) => value.toLowerCase())
  if (normalized.includes("confirm")) return { decision: "confirm" }
  if (normalized.includes("reject")) return { decision: "reject" }
  const reason = selections[0]
  return {
    decision: "reject",
    reason: reason !== undefined && reason.length > 0 ? reason : undefined,
  }
}
