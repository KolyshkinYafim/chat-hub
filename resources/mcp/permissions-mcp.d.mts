export type PermissionResult = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }
export function askPermission(args: unknown, env?: Record<string, string | undefined>): Promise<PermissionResult>
export function handle(message: { method: string; params?: Record<string, unknown> }): Promise<unknown>
