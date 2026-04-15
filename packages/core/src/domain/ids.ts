import { Schema } from "effect"

/** Schema.brand + zero-cost `.of()` constructor in one pipe step. */
export const branded =
  <B extends string>(brand: B) =>
  <S extends Schema.Top>(schema: S) => {
    const result = schema.pipe(Schema.brand(brand))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(result as any)["of"] = (value: any) => value
    return result as typeof result & {
      readonly of: (value: (typeof result)["Encoded"]) => (typeof result)["Type"]
    }
  }

export const SessionId = Schema.String.pipe(branded("SessionId"))
export type SessionId = typeof SessionId.Type

export const BranchId = Schema.String.pipe(branded("BranchId"))
export type BranchId = typeof BranchId.Type

export const MessageId = Schema.String.pipe(branded("MessageId"))
export type MessageId = typeof MessageId.Type

export const TaskId = Schema.String.pipe(branded("TaskId"))
export type TaskId = typeof TaskId.Type

export const ToolCallId = Schema.String.pipe(branded("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const ActorCommandId = Schema.String.pipe(branded("ActorCommandId"))
export type ActorCommandId = typeof ActorCommandId.Type

export const ArtifactId = Schema.String.pipe(branded("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type
