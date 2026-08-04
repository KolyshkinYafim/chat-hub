import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { net, protocol } from "electron"
import { MEDIA_SCHEME } from "@shared/surfaces"
import { parseByteRange } from "./byte-range"
import { isContainedIn } from "./paths"

type MediaGrant = { root: string; absolutePath: string; mime: string }

const MAX_GRANTS = 64

const grants = new Map<string, MediaGrant>()

export function grantMediaUrl(grant: MediaGrant): string {
  const token = randomUUID()
  grants.set(token, grant)
  while (grants.size > MAX_GRANTS) {
    const oldest = grants.keys().next()
    if (oldest.done) break
    grants.delete(oldest.value)
  }
  return `${MEDIA_SCHEME}://stream/${token}`
}

export function revokeMediaGrants(): void {
  grants.clear()
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ])
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const token = new URL(request.url).pathname.replace(/^\/+/, "")
    const grant = grants.get(token)
    if (!grant) return new Response("Unknown media token", { status: 404 })

    const target = await realpath(grant.absolutePath).catch(() => null)
    if (!target || !isContainedIn(grant.root, target)) {
      return new Response("Outside the workspace", { status: 403 })
    }

    const size = (await stat(target)).size
    const range = parseByteRange(request.headers.get("Range"), size)
    const upstream = await net.fetch(pathToFileURL(target).toString(), {
      method: request.method,
      headers: range
        ? { Range: `bytes=${range.start}-${range.end}` }
        : undefined,
      bypassCustomProtocolHandlers: true,
    })
    if (!upstream.ok) {
      return new Response("Could not read the file", { status: 500 })
    }

    const headers = new Headers({
      "Content-Type": grant.mime,
      "Accept-Ranges": "bytes",
      // The token is opaque, so without this the PDF viewer titles the tab with
      // a UUID. RFC 5987 form: always header-safe, whatever the file is called.
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(grant.absolutePath))}`,
    })
    if (!range) {
      headers.set("Content-Length", String(size))
      return new Response(upstream.body, { status: 200, headers })
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
    headers.set("Content-Length", String(range.end - range.start + 1))
    return new Response(upstream.body, { status: 206, headers })
  })
}
