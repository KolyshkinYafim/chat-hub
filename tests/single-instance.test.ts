import { describe, expect, it, vi } from "vitest"

/**
 * Importing the main entry runs its module body, so the stub has to be enough
 * for that: the lock is refused, which is exactly the path where nothing else
 * may happen. Any window, socket or file the losing instance still touched
 * would show up here as a call on a stub that isn't there.
 */
const electronCalls: string[] = []

vi.mock("electron", () => {
  const app = {
    getPath: (name: string) => `/tmp/chat-hub-test/${name}`,
    setPath: () => {
      electronCalls.push("setPath")
    },
    requestSingleInstanceLock: () => {
      electronCalls.push("requestSingleInstanceLock")
      return false
    },
    quit: () => {
      electronCalls.push("quit")
    },
    exit: () => {
      electronCalls.push("exit")
    },
    on: (event: string) => {
      electronCalls.push(`on:${event}`)
    },
    whenReady: () => {
      electronCalls.push("whenReady")
      return new Promise<void>(() => {})
    },
    setName: () => {},
  }
  return {
    app,
    BrowserWindow: class {
      static getAllWindows(): unknown[] {
        return []
      }

      static getFocusedWindow(): unknown {
        return null
      }
    },
    dialog: {},
    ipcMain: {
      handle: () => {
        electronCalls.push("ipcMain.handle")
      },
      on: () => {
        electronCalls.push("ipcMain.on")
      },
    },
    shell: {},
    nativeTheme: {
      prefersReducedTransparency: false,
      on: () => {},
    },
  }
})

const { startSingleInstance } = await import("../src/main/index")

type Hooks = Parameters<typeof startSingleInstance>[0]

function spyHooks(gotLock: boolean): {
  hooks: Hooks
  log: string[]
  secondInstance: () => (() => void) | null
} {
  const log: string[] = []
  let handler: (() => void) | null = null
  return {
    log,
    secondInstance: () => handler,
    hooks: {
      requestLock: () => {
        log.push("requestLock")
        return gotLock
      },
      quit: () => {
        log.push("quit")
      },
      onSecondInstance: (h) => {
        log.push("onSecondInstance")
        handler = h
      },
      boot: () => {
        log.push("boot")
      },
    },
  }
}

describe("startSingleInstance", () => {
  it("quits without booting when the lock is already held", () => {
    const { hooks, log, secondInstance } = spyHooks(false)

    expect(startSingleInstance(hooks)).toBe("quit")
    // Order matters as much as content: quit is the only thing that happens,
    // and it happens after nothing.
    expect(log).toEqual(["requestLock", "quit"])
    expect(secondInstance()).toBeNull()
  })

  it("boots and listens for the second instance when it wins the lock", () => {
    const { hooks, log, secondInstance } = spyHooks(true)

    expect(startSingleInstance(hooks)).toBe("boot")
    expect(log).toEqual(["requestLock", "onSecondInstance", "boot"])
    // Registered before boot: a duplicate launched while the first instance is
    // still opening its window still gets its focus request honoured.
    expect(typeof secondInstance()).toBe("function")
  })

  it("survives a second-instance handler with no window yet", () => {
    const { hooks, secondInstance } = spyHooks(true)
    startSingleInstance(hooks)

    expect(() => secondInstance()?.()).not.toThrow()
  })
})

describe("the losing instance's module body", () => {
  it("asks for the lock, quits, and touches nothing else", () => {
    // Import already happened above with requestSingleInstanceLock() === false.
    expect(electronCalls).toContain("requestSingleInstanceLock")
    expect(electronCalls).toContain("quit")

    const after = electronCalls.slice(
      electronCalls.indexOf("requestSingleInstanceLock"),
    )
    expect(after).toEqual(["requestSingleInstanceLock", "quit"])

    // No app.on(...) at all: whenReady, window-all-closed and before-quit are
    // all inside boot(), which the losing instance never reaches.
    expect(electronCalls).not.toContain("whenReady")
    expect(electronCalls.some((c) => c.startsWith("on:"))).toBe(false)
    expect(electronCalls.some((c) => c.startsWith("ipcMain."))).toBe(false)
  })
})
