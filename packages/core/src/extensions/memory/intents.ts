/**
 * Memory extension intents — command palette operations.
 */

import { Schema } from "effect"

export const AddMemoryIntent = Schema.TaggedStruct("AddMemory", {
  title: Schema.String,
  content: Schema.String,
  scope: Schema.Literals(["session", "project", "global"]),
  tags: Schema.optional(Schema.Array(Schema.String)),
})

export const SearchMemoryIntent = Schema.TaggedStruct("SearchMemory", {
  query: Schema.String,
})

export const ForgetMemoryIntent = Schema.TaggedStruct("ForgetMemory", {
  title: Schema.String,
  scope: Schema.Literals(["session", "project", "global"]),
})

export const PromoteMemoryIntent = Schema.TaggedStruct("PromoteMemory", {
  title: Schema.String,
  toScope: Schema.Literals(["project", "global"]),
})

export const ListMemoriesIntent = Schema.TaggedStruct("ListMemories", {})

export const MemoryIntent = Schema.Union([
  AddMemoryIntent,
  SearchMemoryIntent,
  ForgetMemoryIntent,
  PromoteMemoryIntent,
  ListMemoriesIntent,
])
export type MemoryIntent = typeof MemoryIntent.Type
