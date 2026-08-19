import { Component, type ErrorInfo, type ReactNode } from "react"

type Props = { children: ReactNode }

type State = { error: Error | null }

/**
 * Last line of defence for the whole renderer. React unmounts the entire tree
 * when a render throws, and a blank window tells the user nothing and offers
 * them nothing — this keeps the error on screen with a way back.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] unhandled error", error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-panel">
          <h1 className="crash-title">Chat Hub hit an error</h1>
          <p className="crash-text">
            The window stopped rendering. Your sessions and transcripts are on
            disk and are not affected — reloading picks them back up.
          </p>
          <pre className="crash-detail">{error.message}</pre>
          <button
            type="button"
            className="crash-reload"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
