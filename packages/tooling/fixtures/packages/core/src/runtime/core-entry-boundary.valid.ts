import { EventStore } from "../domain/event.js"
import { makeLanguageModelLayer } from "./provider.js"

export const values = [EventStore, makeLanguageModelLayer]
