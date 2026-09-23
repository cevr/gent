import { createRpcHarness } from "./harness.js"
import { EventStore } from "../domain/event.js"

export const values = [createRpcHarness, EventStore]
