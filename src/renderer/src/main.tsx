import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles.css"
import "./transcript.css"

async function boot() {
  // Dev-only: `?mock=1` renders the UI with sample data (no Electron bridge).
  if (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("mock") &&
    !("chatHub" in window)
  ) {
    const { installDevMock } = await import("./dev-mock")
    installDevMock()
  }

  const root = document.getElementById("root")
  if (!root) throw new Error("root element missing")

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
