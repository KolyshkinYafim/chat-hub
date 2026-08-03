import type { DetailedHTMLProps, HTMLAttributes } from "react"

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        preload?: string
        allowpopups?: string
        useragent?: string
      }
    }
  }
}
