;(function () {
  var COLOR_RE =
    /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\)|hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\))$/
  var TOKEN_RE = /^--[a-z][a-z0-9-]{0,31}$/
  var root = document.documentElement
  try {
    var raw = localStorage.getItem("chat-hub.boot-theme")
    if (raw) {
      var parsed = JSON.parse(raw)
      var tokens = parsed && typeof parsed === "object" ? parsed.tokens : null
      if (tokens && typeof tokens === "object") {
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
      if (parsed && parsed.light === true) {
        root.classList.add("theme-light")
      }
    }
  } catch (err) {
    void err
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
