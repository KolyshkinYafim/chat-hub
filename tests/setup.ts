// Node 25+ exposes its own Web Storage globals. Vitest 3 preserves those when
// installing jsdom, so unqualified localStorage would use Node storage (or be
// undefined without --localstorage-file). Browser tests must use their window.
const browser = (globalThis as typeof globalThis & { jsdom?: { window: Window } }).jsdom?.window
if (browser) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: browser[key],
      writable: true,
    })
  }
}
