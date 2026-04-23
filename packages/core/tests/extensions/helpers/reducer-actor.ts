import { Effect, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import type { AgentEvent } from "@gent/core/domain/event"
import type {
  ExtensionActorDefinition,
  ExtensionTurnContext,
  ExtensionEffect,
  ExtensionReduceContext,
  ReduceResult,
  RequestResult,
  TurnProjection,
} from "../../../src/domain/extension.js"

type DerivedProjection = TurnProjection & {
  readonly uiModel?: unknown
}

export interface TestReducerActorConfig<State, Message = never, Request = never, RequestR = never> {
  readonly id: string
  readonly initial: State
  readonly reduce: (
    state: State,
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => ReduceResult<State>
  readonly derive?: (state: State, ctx?: ExtensionTurnContext) => DerivedProjection
  readonly receive?: (state: State, message: Message) => ReduceResult<State>
  readonly messageSchema?: Schema.Schema<Message>
  readonly request?: (
    state: State,
    message: Request,
  ) => Effect.Effect<RequestResult<State, unknown>, never, RequestR>
  readonly requestSchema?: Schema.Schema<Request>
  readonly uiModelSchema?: Schema.Schema<unknown>
  readonly stateSchema?: Schema.Schema<State>
  readonly persist?: boolean
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly onInit?: ExtensionActorDefinition<
    { readonly _tag: "Active"; readonly value: State },
    { readonly _tag: string }
  >["onInit"]
}

export const reducerActor = <State, Message = never, Request = never, RequestR = never>(
  config: TestReducerActorConfig<State, Message, Request, RequestR>,
): ExtensionActorDefinition<
  { readonly _tag: "Active"; readonly value: State },
  { readonly _tag: string },
  RequestR
> => {
  const stateSchema = (config.stateSchema ?? Schema.Unknown) as Schema.Schema<State>
  const commandSchema = (config.messageSchema ?? Schema.Unknown) as Schema.Schema<Message>
  const requestSchema = (config.requestSchema ?? Schema.Unknown) as Schema.Schema<Request>

  const WrappedState = MState({
    Active: {
      value: stateSchema,
    },
  })

  const WrappedEvent = MEvent({
    Published: {
      event: Schema.Unknown,
      ctx: Schema.Unknown,
    },
    Command: {
      message: commandSchema,
    },
    Request: MEvent.reply(
      {
        message: requestSchema,
      },
      Schema.Unknown,
    ),
  })

  const machine = Machine.make({
    state: WrappedState,
    event: WrappedEvent,
    initial: WrappedState.Active({ value: config.initial }),
  })
    .on(WrappedState.Active, WrappedEvent.Published, ({ state, event }) => {
      const result = config.reduce(
        state.value,
        event.event as AgentEvent,
        event.ctx as ExtensionReduceContext,
      )
      return result.state === state.value ? state : WrappedState.Active({ value: result.state })
    })
    .on(WrappedState.Active, WrappedEvent.Command, ({ state, event }) => {
      if (config.receive === undefined) return state
      const result = config.receive(state.value, event.message)
      return result.state === state.value ? state : WrappedState.Active({ value: result.state })
    })
    .on(WrappedState.Active, WrappedEvent.Request, ({ state, event }) =>
      Effect.gen(function* () {
        if (config.request === undefined) {
          return Machine.reply(state, undefined)
        }
        const result = yield* config.request(state.value, event.message)
        const nextState =
          result.state === state.value ? state : WrappedState.Active({ value: result.state })
        return Machine.reply(nextState, result.reply)
      }),
    )

  return {
    machine,
    mapEvent: (event) =>
      WrappedEvent.Published({
        event,
        ctx: { sessionId: event.sessionId, branchId: event.branchId },
      }),
    mapCommand:
      config.receive === undefined
        ? undefined
        : (message) => WrappedEvent.Command({ message: message as Message }),
    mapRequest:
      config.request === undefined
        ? undefined
        : (message) => WrappedEvent.Request({ message: message as Request }),
    snapshot:
      config.derive === undefined
        ? {
            schema: config.uiModelSchema,
            project: (state) => state.value,
          }
        : {
            schema: config.uiModelSchema,
            project: (state) => config.derive!(state.value, undefined).uiModel,
          },
    turn:
      config.derive === undefined
        ? undefined
        : {
            project: (state, ctx) => {
              const { uiModel: _, ...turn } = config.derive!(state.value, ctx)
              return turn
            },
          },
    stateSchema: config.persist ? WrappedState : undefined,
    afterTransition:
      config.afterTransition === undefined
        ? undefined
        : (before, after) => config.afterTransition!(before.value, after.value),
    onInit: config.onInit,
  }
}
