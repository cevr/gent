import { SessionId } from "@gent/core/protocol"
import { GentPlatform } from "@gent/core/host"
import { LanguageModelLayers } from "@gent/core/test-utils"
import { AgentName } from "@gent/core/domain/agent"
import { EventStore } from "../../core/src/domain/event"
import { SqliteStorage } from "../../../packages/core/src/host.js"
export { MessageStorage } from "@gent/core/storage/message-storage"
export * from "@gent/core/host"

export const loadRuntime = () => import("@gent/core/runtime/session-runtime")

export const values = [SessionId, GentPlatform, LanguageModelLayers, AgentName, EventStore, SqliteStorage]
