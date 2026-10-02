import { Session } from "../domain/message.js"
// The test harness may seed a child chain without runtime depth admission.
export const seeded = new Session({ id, parentSessionId })
