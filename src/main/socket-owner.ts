import { connect } from "node:net"
import { unlinkSync } from "node:fs"

/**
 * Electron's single-instance lock is keyed on the user-data directory, so a
 * second Hub started with its own CHAT_HUB_USER_DATA (an E2E run, a scratch
 * profile) gets past it — and then clears the socket file the first Hub is
 * still listening on, leaving that Hub's agents talking to nobody. Only a
 * socket nobody answers on is a leftover from a crash.
 */
export function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", () => resolve(false))
  })
}

export class SocketInUseError extends Error {
  constructor(path: string) {
    super(`Another Chat Hub is already serving ${path}`)
    this.name = "SocketInUseError"
  }
}

/** Remove a stale socket file, or refuse when a live Hub still owns it. */
export async function clearStaleSocket(path: string): Promise<void> {
  if (await socketAnswers(path)) throw new SocketInUseError(path)
  try {
    unlinkSync(path)
  } catch {
    /* nothing to clear */
  }
}
