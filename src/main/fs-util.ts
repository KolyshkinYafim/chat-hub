/** True when the error is Node's "no such file or directory". */
export function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT"
}
