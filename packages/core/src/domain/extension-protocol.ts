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

export interface ExtensionCommandDefinition<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
> {
  readonly extensionId: Id
  readonly _tag: Tag
  readonly make: MessageFactory<F, ExtensionCommandMessage<Id, Tag, F>>
  readonly payloadSchema: Schema.Schema<PayloadType<F>>
  readonly schema: Schema.Decoder<ExtensionCommandMessage<Id, Tag, F>>
  /**
   * Full-shape narrow: the message carries this command's `extensionId`/`_tag`
   * AND its payload matches the declared fields. Use when the discriminator
   * alone isn't a contract — e.g. routing a message to a handler that reads
   * typed payload fields.
   */
  readonly is: (message: AnyExtensionMessage) => message is ExtensionCommandMessage<Id, Tag, F>
  /**
   * Cheap envelope-only check — `extensionId` and `_tag` match, nothing
   * about the payload. Use for routing decisions that do not read payload
   * fields (dispatch tables, logging, metrics).
   */
  readonly hasEnvelopeTag: (message: AnyExtensionMessage) => boolean
}

export interface ExtensionRequestDefinition<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
  R,
> {
  readonly extensionId: Id
  readonly _tag: Tag
  readonly make: MessageFactory<F, ExtensionRequestMessage<Id, Tag, F, R>>
  readonly payloadSchema: Schema.Schema<PayloadType<F>>
  readonly replySchema: Schema.Codec<R, unknown, never, never>
  readonly replyDecoder: Schema.Decoder<R>
  readonly schema: Schema.Decoder<ExtensionRequestMessage<Id, Tag, F, R>>
  /** See {@link ExtensionCommandDefinition.is}. */
  readonly is: (message: AnyExtensionMessage) => message is ExtensionRequestMessage<Id, Tag, F, R>
  /** See {@link ExtensionCommandDefinition.hasEnvelopeTag}. */
  readonly hasEnvelopeTag: (message: AnyExtensionMessage) => boolean
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
  readonly _tag: "command"
  readonly extensionId: string
  readonly tag: string
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Decoder<unknown>
}

interface ExtensionRequestMetadata<R = unknown> {
  readonly _tag: "request"
  readonly extensionId: string
  readonly tag: string
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Decoder<unknown>
  readonly replySchema: Schema.Codec<R, unknown, never, never>
  readonly replyDecoder: Schema.Decoder<R>
}

type ExtensionProtocolMetadata = ExtensionCommandMetadata | ExtensionRequestMetadata<unknown>
export type ExtensionMessageMetadata = ExtensionProtocolMetadata
type ExtensionDefinitionMetadata = ExtensionProtocolMetadata

const ExtensionMessageMetadataSymbol = Symbol.for("@gent/core/extension-protocol/message-metadata")
const ExtensionDefinitionMetadataSymbol = Symbol.for(
  "@gent/core/extension-protocol/definition-metadata",
)

const assertFields = (fields: ExtensionFields) => {
  if ("extensionId" in fields || "_tag" in fields) {
    throw new Error("extension protocol fields cannot redefine reserved keys: extensionId, _tag")
  }
}

const assertPayload = (payload: unknown) => {
  if ((typeof payload !== "object" && typeof payload !== "function") || payload === null) {
    return
  }
  if ("extensionId" in payload || "_tag" in payload) {
    throw new Error("extension protocol payload cannot redefine reserved keys: extensionId, _tag")
  }
}

const attachMessageMetadata = <M extends object>(
  message: M,
  metadata: ExtensionMessageMetadata,
): M => {
  Object.defineProperty(message, ExtensionMessageMetadataSymbol, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return message
}

const attachDefinitionMetadata = <D extends object>(
  definition: D,
  metadata: ExtensionDefinitionMetadata,
): D => {
  Object.defineProperty(definition, ExtensionDefinitionMetadataSymbol, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return definition
}

const readHiddenMetadata = (
  value: unknown,
  symbol: symbol,
): ExtensionProtocolMetadata | undefined => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  return (value as Record<PropertyKey, unknown>)[symbol] as ExtensionProtocolMetadata | undefined
}

const createCommand = <Id extends string, Tag extends string, F extends ExtensionFields>(
  extensionId: Id,
  tag: Tag,
  fields: F,
): ExtensionCommandDefinition<Id, Tag, F> => {
  assertFields(fields)
  const payloadSchema = Schema.Struct(fields)
  const rawSchema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  const schema = rawSchema as unknown as Schema.Decoder<ExtensionCommandMessage<Id, Tag, F>>

  const metadata: ExtensionCommandMetadata = {
    _tag: "command",
    extensionId,
    tag,
    payloadSchema,
    schema,
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  const make = ((payload?: PayloadType<F>) => {
    assertPayload(payload)
    return attachMessageMetadata(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionCommandMessage<Id, Tag, F>,
      metadata,
    )
  }) as MessageFactory<F, ExtensionCommandMessage<Id, Tag, F>>

  const isFullShape = Schema.is(rawSchema)
  const is = (message: AnyExtensionMessage): message is ExtensionCommandMessage<Id, Tag, F> =>
    isFullShape(message)
  const hasEnvelopeTag = (message: AnyExtensionMessage) =>
    message.extensionId === extensionId && message._tag === tag

  return attachDefinitionMetadata(
    {
      extensionId,
      _tag: tag,
      make,
      payloadSchema,
      schema,
      is,
      hasEnvelopeTag,
    },
    metadata,
  )
}

const createRequest = <Id extends string, Tag extends string, F extends ExtensionFields, R>(
  extensionId: Id,
  tag: Tag,
  fields: F,
  replySchema: Schema.Codec<R, unknown, never, never>,
): ExtensionRequestDefinition<Id, Tag, F, R> => {
  assertFields(fields)
  const payloadSchema = Schema.Struct(fields)
  const rawSchema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  const schema = rawSchema as unknown as Schema.Decoder<ExtensionRequestMessage<Id, Tag, F, R>>

  const replyDecoder: Schema.Decoder<R> = replySchema

  const metadata: ExtensionRequestMetadata<R> = {
    _tag: "request",
    extensionId,
    tag,
    payloadSchema,
    schema,
    replySchema,
    replyDecoder,
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  const make = ((payload?: PayloadType<F>) => {
    assertPayload(payload)
    return attachMessageMetadata(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionRequestMessage<Id, Tag, F, R>,
      metadata,
    )
  }) as MessageFactory<F, ExtensionRequestMessage<Id, Tag, F, R>>

  const isFullShape = Schema.is(rawSchema)
  const is = (message: AnyExtensionMessage): message is ExtensionRequestMessage<Id, Tag, F, R> =>
    isFullShape(message)
  const hasEnvelopeTag = (message: AnyExtensionMessage) =>
    message.extensionId === extensionId && message._tag === tag

  return attachDefinitionMetadata(
    {
      extensionId,
      _tag: tag,
      make,
      payloadSchema,
      replySchema,
      replyDecoder,
      schema,
      is,
      hasEnvelopeTag,
    },
    metadata,
  )
}

export const ExtensionMessage = {
  command: createCommand,
  reply: createRequest,
} as const

export const getExtensionMessageMetadata = (
  message: unknown,
): ExtensionMessageMetadata | undefined => {
  return readHiddenMetadata(message, ExtensionMessageMetadataSymbol)
}

const getExtensionDefinitionMetadata = (
  definition: unknown,
): ExtensionDefinitionMetadata | undefined => {
  return readHiddenMetadata(definition, ExtensionDefinitionMetadataSymbol)
}

export const getExtensionReplySchema = <M>(
  message: M,
): Schema.Schema<ExtractExtensionReply<M>> | undefined => {
  const metadata = getExtensionMessageMetadata(message)
  if (metadata?._tag !== "request") return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  return metadata.replySchema as Schema.Schema<ExtractExtensionReply<M>>
}

export const getExtensionReplyDecoder = <M>(
  message: M,
): Schema.Decoder<ExtractExtensionReply<M>> | undefined => {
  const metadata = getExtensionMessageMetadata(message)
  if (metadata?._tag !== "request") return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
  return metadata.replyDecoder as Schema.Decoder<ExtractExtensionReply<M>>
}

export const isExtensionRequestMessage = (
  message: unknown,
): message is ExtensionRequestMessage<string, string, ExtensionFields, unknown> =>
  getExtensionMessageMetadata(message)?._tag === "request"

export const isExtensionRequestDefinition = (
  definition: unknown,
): definition is AnyExtensionRequestDefinition =>
  getExtensionDefinitionMetadata(definition)?._tag === "request"

export const listExtensionProtocolDefinitions = (
  protocol: ExtensionProtocol,
): ReadonlyArray<AnyExtensionMessageDefinition> =>
  Object.entries(protocol).map(([key, value]) => {
    const metadata = getExtensionDefinitionMetadata(value)
    if (typeof value !== "object" || value === null || metadata === undefined) {
      throw new ExtensionProtocolError({
        extensionId: metadata?.extensionId ?? "(unknown)",
        tag: key,
        phase: "registration",
        message: `protocol entry "${key}" is not a message definition`,
      })
    }
    if (typeof metadata.extensionId !== "string" || typeof metadata.tag !== "string") {
      throw new ExtensionProtocolError({
        extensionId: metadata.extensionId,
        tag: metadata.tag,
        phase: "registration",
        message: `protocol entry "${key}" is not a valid message definition`,
      })
    }
    if (metadata._tag === "request" && metadata.replySchema === undefined) {
      throw new ExtensionProtocolError({
        extensionId: metadata.extensionId,
        tag: metadata.tag,
        phase: "registration",
        message: `request protocol entry "${key}" is missing a reply schema`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
    return value as AnyExtensionMessageDefinition
  })

export const ExtensionMessageEnvelope = Schema.StructWithRest(
  Schema.Struct({
    extensionId: Schema.String,
    _tag: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type ExtensionMessageEnvelope = typeof ExtensionMessageEnvelope.Type
