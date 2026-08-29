;(function () {
  var COLOR_RE =
    /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\)|hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\))$/
  var TOKEN_RE = /^--[a-z][a-z0-9-]{0,31}$/
  var root = document.documentElement
  var cockpit = false
  try {
    cockpit = /(?:^|[?&])cockpit=1(?:&|$)/.test(String(location.search))
  } catch (err0) {
    void err0
  }
  if (cockpit) root.classList.add("cockpit")
  try {
    var raw = localStorage.getItem("chat-hub.boot-theme")
    if (raw) {
      var parsed = JSON.parse(raw)
      var skipStored = cockpit && parsed && parsed.light === true
      var tokens = parsed && typeof parsed === "object" ? parsed.tokens : null
      if (!skipStored && tokens && typeof tokens === "object") {
        for (var key in tokens) {
          if (
            TOKEN_RE.test(key) &&
            typeof tokens[key] === "string" &&
            COLOR_RE.test(tokens[key])
          ) {
            root.style.setProperty(key, tokens[key])
          }
        }
      }
      if (!skipStored && parsed && parsed.light === true) {
        root.classList.add("theme-light")
      }
    }
  } catch (err) {
    void err
  }
  if (cockpit) {
    var glass = {
      "--bg": "rgba(12, 13, 18, 0.22)",
      "--bg-sidebar": "rgba(19, 20, 25, 0.66)",
      "--bg-elevated": "rgba(26, 29, 38, 0.55)",
      "--border-soft": "rgba(255, 255, 255, 0.06)",
      "--border-strong": "rgba(255, 255, 255, 0.16)",
      "--composer-bg": "rgba(22, 24, 29, 0.62)",
    }
    for (var g in glass) root.style.setProperty(g, glass[g])
    if (root.classList.remove) root.classList.remove("theme-light")
  }
  try {
    var width = parseInt(
      localStorage.getItem("chat-hub.sidebar.width") || "",
      10,
    )
    if (isFinite(width)) {
      width = Math.min(420, Math.max(200, width))
      root.style.setProperty("--sidebar-w", width + "px")
    }
  } catch (err2) {
    void err2
  }
})()
