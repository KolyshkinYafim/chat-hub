export type LangfuseConfig = {
  enabled: boolean
  baseUrl: string
  metadataOnly: boolean
  excludedProjects: string[]
}
export type LangfuseStatus = LangfuseConfig & {
  hasPublicKey: boolean
  hasSecretKey: boolean
  pending: number
  lastError: string | null
  lastSentAt: number | null
}
export type LangfusePatch = Partial<LangfuseConfig> & {
  publicKey?: string
  secretKey?: string
}
export const DEFAULT_LANGFUSE: LangfuseConfig = {
  enabled: false,
  baseUrl: "https://cloud.langfuse.com",
  metadataOnly: true,
  excludedProjects: [],
}
