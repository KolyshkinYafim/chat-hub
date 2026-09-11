import { lstatSync, unlinkSync } from "node:fs"
import { connect } from "node:net"

/** Clear only a stale socket, never an active server or an unrelated file. */
export async function prepareSocketPath(path: string): Promise<void> {
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!before.isSocket()) throw new Error(`Refusing to replace a non-socket path: ${path}`)
  const stale = await new Promise<boolean>((resolve) => {
    const socket = connect(path)
    socket.setTimeout(1000)
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.once("connect", () => finish(false))
    socket.once("timeout", () => finish(false))
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT")
    })
  })
  if (!stale) throw new Error(`Socket is already in use: ${path}`)
  try {
    const current = lstatSync(path)
    if (current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error(`Socket changed while checking ownership: ${path}`)
    }
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
