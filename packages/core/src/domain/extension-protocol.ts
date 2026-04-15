import { Schema } from "effect"
import type { Brand } from "effect/Brand"

type ExtensionFields = Schema.Struct.Fields
type PayloadType<F extends ExtensionFields> = Schema.Schema.Type<Schema.Struct<F>>

export type ExtensionMessageTypeId = "@gent/core/ExtensionMessageTypeId"
export type ExtensionProtocolSchemaTypeId = "@gent/core/ExtensionProtocolSchemaTypeId"
export type ExtensionReplyTypeId = "@gent/core/ExtensionReplyTypeId"

export interface ExtensionMessageBrand extends Brand<ExtensionMessageTypeId> {}

export interface ExtensionProtocolSchemaBrand<
  _D extends Record<string, unknown>,
> extends Brand<ExtensionProtocolSchemaTypeId> {}

export interface ExtensionReplyTypeBrand<R> extends Brand<ExtensionReplyTypeId> {
  readonly _ReplyType: R
}

export type ExtractExtensionReply<M> = M extends ExtensionReplyTypeBrand<infer R> ? R : never

export class ExtensionProtocolError extends Schema.TaggedErrorClass<ExtensionProtocolError>()(
  "ExtensionProtocolError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    phase: Schema.Literals([
      "command",
      "request",
      "reply",
      "client-reply",
      "registration",
      "lifecycle",
    ]),
    message: Schema.String,
  },
) {}

type ExtensionEnvelopeRecord = Readonly<Record<string, unknown>>

export type ExtensionCommandMessage<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
> = Readonly<{
  readonly extensionId: Id
  readonly _tag: Tag
}> &
  ExtensionEnvelopeRecord &
  PayloadType<F> &
  ExtensionMessageBrand &
  ExtensionProtocolSchemaBrand<F>

export type ExtensionRequestMessage<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
  R,
> = ExtensionCommandMessage<Id, Tag, F> & ExtensionReplyTypeBrand<R>

type MessageFactory<F extends ExtensionFields, M> = keyof F extends never
  ? () => M
  : (payload: PayloadType<F>) => M

export type ExtensionCommandDefinition<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
> = MessageFactory<F, ExtensionCommandMessage<Id, Tag, F>> & {
  readonly extensionId: Id
  readonly _tag: Tag
  readonly kind: "command"
  readonly payloadSchema: Schema.Schema<PayloadType<F>>
  readonly schema: Schema.Decoder<ExtensionCommandMessage<Id, Tag, F>>
  readonly is: (message: AnyExtensionMessage) => message is ExtensionCommandMessage<Id, Tag, F>
}

export type ExtensionRequestDefinition<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
  R,
> = MessageFactory<F, ExtensionRequestMessage<Id, Tag, F, R>> & {
  readonly extensionId: Id
  readonly _tag: Tag
  readonly kind: "request"
  readonly payloadSchema: Schema.Schema<PayloadType<F>>
  readonly replySchema: Schema.Codec<R, unknown, never, never>
  readonly replyDecoder: Schema.Decoder<R>
  readonly schema: Schema.Decoder<ExtensionRequestMessage<Id, Tag, F, R>>
  readonly is: (message: AnyExtensionMessage) => message is ExtensionRequestMessage<Id, Tag, F, R>
}

export type AnyExtensionCommandDefinition = ExtensionCommandDefinition<
  string,
  string,
  ExtensionFields
>

export type AnyExtensionRequestDefinition = ExtensionRequestDefinition<
  string,
  string,
  ExtensionFields,
  unknown
>

export type AnyExtensionMessageDefinition =
  | AnyExtensionCommandDefinition
  | AnyExtensionRequestDefinition

type ExtensionEnvelope = Readonly<{
  readonly extensionId: string
  readonly _tag: string
}> &
  ExtensionEnvelopeRecord

export type AnyExtensionCommandMessage = ExtensionEnvelope
export type AnyExtensionRequestMessage = ExtensionEnvelope

export type AnyExtensionMessage = AnyExtensionCommandMessage | AnyExtensionRequestMessage

export type ExtensionProtocol = Readonly<Record<string, unknown>>

interface ExtensionCommandMetadata {
  readonly extensionId: string
  readonly tag: string
  readonly kind: "command"
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Decoder<unknown>
}

interface ExtensionRequestMetadata {
  readonly extensionId: string
  readonly tag: string
  readonly kind: "request"
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Decoder<unknown>
  readonly replySchema: Schema.Codec<unknown, unknown, never, never>
  readonly replyDecoder: Schema.Decoder<unknown>
}

export type ExtensionMessageMetadata = ExtensionCommandMetadata | ExtensionRequestMetadata

const ExtensionMessageMetadataSymbol = Symbol.for("@gent/core/extension-protocol/metadata")

const assertFields = (fields: ExtensionFields) => {
  if ("extensionId" in fields || "_tag" in fields) {
    throw new Error("extension protocol fields cannot redefine reserved keys: extensionId, _tag")
  }
}

const attachMetadata = <M extends object>(message: M, metadata: ExtensionMessageMetadata): M => {
  Object.defineProperty(message, ExtensionMessageMetadataSymbol, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return message
}

const createCommand = <Id extends string, Tag extends string, F extends ExtensionFields>(
  extensionId: Id,
  tag: Tag,
  fields: F,
): ExtensionCommandDefinition<Id, Tag, F> => {
  assertFields(fields)
  const payloadSchema = Schema.Struct(fields)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const schema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  }) as unknown as Schema.Decoder<ExtensionCommandMessage<Id, Tag, F>>

  const metadata: ExtensionCommandMetadata = {
    extensionId,
    tag,
    kind: "command",
    payloadSchema,
    schema,
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const make = ((payload?: PayloadType<F>) =>
    attachMetadata(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionCommandMessage<Id, Tag, F>,
      metadata,
    )) as unknown as ExtensionCommandDefinition<Id, Tag, F>

  const is = (message: AnyExtensionMessage): message is ExtensionCommandMessage<Id, Tag, F> =>
    message.extensionId === extensionId && message._tag === tag

  return Object.assign(make, {
    extensionId,
    _tag: tag,
    kind: "command" as const,
    payloadSchema,
    schema,
    is,
  })
}

const createRequest = <
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
  RS extends Schema.Codec<unknown, unknown, never, never>,
>(
  extensionId: Id,
  tag: Tag,
  fields: F,
  replySchema: RS,
): ExtensionRequestDefinition<Id, Tag, F, Schema.Schema.Type<RS>> => {
  assertFields(fields)
  const payloadSchema = Schema.Struct(fields)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const schema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  }) as unknown as Schema.Decoder<ExtensionRequestMessage<Id, Tag, F, Schema.Schema.Type<RS>>>

  const metadata: ExtensionRequestMetadata = {
    extensionId,
    tag,
    kind: "request",
    payloadSchema,
    schema,
    replySchema,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    replyDecoder: replySchema as Schema.Decoder<Schema.Schema.Type<RS>>,
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const make = ((payload?: PayloadType<F>) =>
    attachMetadata(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionRequestMessage<Id, Tag, F, Schema.Schema.Type<RS>>,
      metadata,
    )) as unknown as ExtensionRequestDefinition<Id, Tag, F, Schema.Schema.Type<RS>>

  const is = (
    message: AnyExtensionMessage,
  ): message is ExtensionRequestMessage<Id, Tag, F, Schema.Schema.Type<RS>> =>
    message.extensionId === extensionId && message._tag === tag

  return Object.assign(make, {
    extensionId,
    _tag: tag,
    kind: "request" as const,
    payloadSchema,
    replySchema,
    replyDecoder: metadata.replyDecoder,
    schema,
    is,
  })
}

export const ExtensionMessage = Object.assign(createCommand, {
  reply: createRequest,
})

export const getExtensionMessageMetadata = (
  message: unknown,
): ExtensionMessageMetadata | undefined => {
  if (typeof message !== "object" || message === null) return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return (message as Record<PropertyKey, unknown>)[ExtensionMessageMetadataSymbol] as
    | ExtensionMessageMetadata
    | undefined
}

export const getExtensionReplySchema = <M>(
  message: M,
): Schema.Schema<ExtractExtensionReply<M>> | undefined => {
  const metadata = getExtensionMessageMetadata(message)
  if (metadata?.kind !== "request") return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return metadata.replySchema as Schema.Schema<ExtractExtensionReply<M>>
}

export const getExtensionReplyDecoder = <M>(
  message: M,
): Schema.Decoder<ExtractExtensionReply<M>> | undefined => {
  const metadata = getExtensionMessageMetadata(message)
  if (metadata?.kind !== "request") return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return metadata.replyDecoder as Schema.Decoder<ExtractExtensionReply<M>>
}

export const isExtensionRequestMessage = (
  message: unknown,
): message is ExtensionRequestMessage<string, string, ExtensionFields, unknown> =>
  getExtensionMessageMetadata(message)?.kind === "request"

export const listExtensionProtocolDefinitions = (
  protocol: ExtensionProtocol,
): ReadonlyArray<AnyExtensionMessageDefinition> =>
  Object.entries(protocol).map(([key, value]) => {
    if (typeof value !== "function") {
      throw new ExtensionProtocolError({
        extensionId: "(unknown)",
        tag: key,
        phase: "registration",
        message: `protocol entry "${key}" is not a message definition`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const definition = value as Partial<AnyExtensionMessageDefinition>
    if (
      typeof definition.extensionId !== "string" ||
      typeof definition._tag !== "string" ||
      (definition.kind !== "command" && definition.kind !== "request") ||
      definition.schema === undefined
    ) {
      throw new ExtensionProtocolError({
        extensionId: definition.extensionId ?? "(unknown)",
        tag: definition._tag ?? key,
        phase: "registration",
        message: `protocol entry "${key}" is not a valid message definition`,
      })
    }
    if (definition.kind === "request" && definition.replySchema === undefined) {
      throw new ExtensionProtocolError({
        extensionId: definition.extensionId,
        tag: definition._tag,
        phase: "registration",
        message: `request protocol entry "${key}" is missing a reply schema`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return definition as AnyExtensionMessageDefinition
  })

export const ExtensionMessageEnvelope = Schema.StructWithRest(
  Schema.Struct({
    extensionId: Schema.String,
    _tag: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type ExtensionMessageEnvelope = typeof ExtensionMessageEnvelope.Type
