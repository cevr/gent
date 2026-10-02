import { Session } from "../domain/message.js"
// Storage rebuilds rows from the database; a stored parent is already admitted.
export const decodeSession = (row) => new Session({ id: row.id, parentSessionId: row.parent })
