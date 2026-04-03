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

export type ExtensionCommandMessage<
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
> = Readonly<{
  readonly extensionId: Id
  readonly _tag: Tag
}> &
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
  readonly schema: Schema.Schema<ExtensionCommandMessage<Id, Tag, F>>
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
  readonly replySchema: Schema.Schema<R>
  readonly schema: Schema.Schema<ExtensionRequestMessage<Id, Tag, F, R>>
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
  object

export type AnyExtensionCommandMessage = ExtensionEnvelope
export type AnyExtensionRequestMessage = ExtensionEnvelope

export type AnyExtensionMessage = AnyExtensionCommandMessage | AnyExtensionRequestMessage

interface ExtensionCommandMetadata {
  readonly extensionId: string
  readonly tag: string
  readonly kind: "command"
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Schema<unknown>
}

interface ExtensionRequestMetadata {
  readonly extensionId: string
  readonly tag: string
  readonly kind: "request"
  readonly payloadSchema: Schema.Schema<unknown>
  readonly schema: Schema.Schema<unknown>
  readonly replySchema: Schema.Schema<unknown>
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
  const schema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  }) as unknown as Schema.Schema<ExtensionCommandMessage<Id, Tag, F>>

  const metadata: ExtensionCommandMetadata = {
    extensionId,
    tag,
    kind: "command",
    payloadSchema,
    schema,
  }

  const make = ((payload?: PayloadType<F>) =>
    attachMetadata(
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionCommandMessage<Id, Tag, F>,
      metadata,
    )) as unknown as ExtensionCommandDefinition<Id, Tag, F>

  return Object.assign(make, {
    extensionId,
    _tag: tag,
    kind: "command" as const,
    payloadSchema,
    schema,
  })
}

const createRequest = <
  Id extends string,
  Tag extends string,
  F extends ExtensionFields,
  RS extends Schema.Schema<unknown>,
>(
  extensionId: Id,
  tag: Tag,
  fields: F,
  replySchema: RS,
): ExtensionRequestDefinition<Id, Tag, F, Schema.Schema.Type<RS>> => {
  assertFields(fields)
  const payloadSchema = Schema.Struct(fields)
  const schema = Schema.Struct({
    extensionId: Schema.Literal(extensionId),
    _tag: Schema.Literal(tag),
    ...fields,
  }) as unknown as Schema.Schema<ExtensionRequestMessage<Id, Tag, F, Schema.Schema.Type<RS>>>

  const metadata: ExtensionRequestMetadata = {
    extensionId,
    tag,
    kind: "request",
    payloadSchema,
    schema,
    replySchema,
  }

  const make = ((payload?: PayloadType<F>) =>
    attachMetadata(
      {
        extensionId,
        _tag: tag,
        ...(payload ?? {}),
      } as ExtensionRequestMessage<Id, Tag, F, Schema.Schema.Type<RS>>,
      metadata,
    )) as unknown as ExtensionRequestDefinition<Id, Tag, F, Schema.Schema.Type<RS>>

  return Object.assign(make, {
    extensionId,
    _tag: tag,
    kind: "request" as const,
    payloadSchema,
    replySchema,
    schema,
  })
}

export const ExtensionMessage = Object.assign(createCommand, {
  reply: createRequest,
})

export const getExtensionMessageMetadata = (
  message: unknown,
): ExtensionMessageMetadata | undefined => {
  if (typeof message !== "object" || message === null) return undefined
  return (message as Record<PropertyKey, unknown>)[ExtensionMessageMetadataSymbol] as
    | ExtensionMessageMetadata
    | undefined
}

export const getExtensionReplySchema = <M>(
  message: M,
): Schema.Schema<ExtractExtensionReply<M>> | undefined => {
  const metadata = getExtensionMessageMetadata(message)
  if (metadata?.kind !== "request") return undefined
  return metadata.replySchema as Schema.Schema<ExtractExtensionReply<M>>
}

export const isExtensionRequestMessage = (
  message: unknown,
): message is ExtensionRequestMessage<string, string, ExtensionFields, unknown> =>
  getExtensionMessageMetadata(message)?.kind === "request"
