export const PICK_GLOBAL = "__chathubPick"

export type PickTarget = {
  selector: string
  tag: string
  text: string
  href?: string
  rect: { x: number; y: number; width: number; height: number }
}

/**
 * Evaluated inside the untrusted guest page: installs a hover outline overlay
 * and a capture-phase click trap that records the clicked element as plain
 * data on `window.__chathubPick.pending` without touching element styles.
 */
export function enablePickScript(): string {
  return `(function () {
  if (window.${PICK_GLOBAL}) return true
  var doc = document
  var overlay = doc.createElement("div")
  overlay.setAttribute("data-chathub-pick-overlay", "")
  overlay.style.position = "fixed"
  overlay.style.zIndex = "2147483647"
  overlay.style.pointerEvents = "none"
  overlay.style.outline = "2px solid #5b8ef7"
  overlay.style.outlineOffset = "1px"
  overlay.style.display = "none"
  var host = doc.body || doc.documentElement
  host.appendChild(overlay)

  var collapse = function (value) {
    return String(value == null ? "" : value).replace(/\\s+/g, " ").trim()
  }
  var cssEscape = function (value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value)
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\\\$1")
  }
  var unique = function (sel) {
    try {
      return doc.querySelectorAll(sel).length === 1
    } catch (err) {
      return false
    }
  }
  var nthOfType = function (el) {
    var index = 1
    var sib = el
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) index += 1
    }
    return index
  }
  var partFor = function (el, exact) {
    var part = String(el.tagName || "").toLowerCase()
    var classes = el.classList ? el.classList : []
    for (var i = 0; i < classes.length && i < 2; i += 1) {
      part += "." + cssEscape(classes[i])
    }
    if (exact) part += ":nth-of-type(" + nthOfType(el) + ")"
    return part
  }
  var pathFrom = function (el, depth, exact) {
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && parts.length < depth) {
      parts.unshift(partFor(node, exact))
      if (node === doc.body || node === doc.documentElement) break
      node = node.parentElement
    }
    return parts.join(" > ")
  }
  var selectorFor = function (el) {
    if (el.id) {
      var byId = "#" + cssEscape(el.id)
      if (unique(byId)) return byId
    }
    var testId = el.getAttribute && el.getAttribute("data-testid")
    if (testId) {
      var byTestId = '[data-testid="' + String(testId).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"]'
      if (unique(byTestId)) return byTestId
    }
    var depth
    for (depth = 1; depth <= 4; depth += 1) {
      var loose = pathFrom(el, depth, false)
      if (unique(loose)) return loose
    }
    for (depth = 1; depth <= 4; depth += 1) {
      var exact = pathFrom(el, depth, true)
      if (unique(exact)) return exact
    }
    return pathFrom(el, 32, true)
  }
  var describeTarget = function (el) {
    var raw = typeof el.innerText === "string" ? el.innerText : el.textContent
    var box = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    var pick = {
      selector: selectorFor(el),
      tag: String(el.tagName || "").toLowerCase(),
      text: collapse(raw).slice(0, 120),
      rect: box
        ? { x: box.left, y: box.top, width: box.width, height: box.height }
        : { x: 0, y: 0, width: 0, height: 0 },
    }
    var anchor = el.closest ? el.closest("a[href]") : null
    if (anchor) pick.href = String(anchor.href || anchor.getAttribute("href") || "")
    return pick
  }

  var onOver = function (event) {
    var el = event.target
    if (!el || el.nodeType !== 1 || el === overlay) return
    var box = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    if (!box) return
    overlay.style.display = "block"
    overlay.style.left = box.left + "px"
    overlay.style.top = box.top + "px"
    overlay.style.width = box.width + "px"
    overlay.style.height = box.height + "px"
  }
  var onClick = function (event) {
    var el = event.target
    if (!el || el.nodeType !== 1 || el === overlay) return
    event.preventDefault()
    event.stopPropagation()
    window.${PICK_GLOBAL}.pending = describeTarget(el)
  }

  doc.addEventListener("mouseover", onOver, true)
  doc.addEventListener("click", onClick, true)
  window.${PICK_GLOBAL} = {
    pending: null,
    overlay: overlay,
    onOver: onOver,
    onClick: onClick,
  }
  return true
})()`
}

/** Returns the pending pick as plain data and clears it, or null. */
export function readPickScript(): string {
  return `(function () {
  var state = window.${PICK_GLOBAL}
  if (!state || !state.pending) return null
  var pick = state.pending
  state.pending = null
  return pick
})()`
}

/** Removes the listeners, the overlay, and the global — a full undo of enable. */
export function disablePickScript(): string {
  return `(function () {
  var state = window.${PICK_GLOBAL}
  if (!state) return false
  document.removeEventListener("mouseover", state.onOver, true)
  document.removeEventListener("click", state.onClick, true)
  if (state.overlay && state.overlay.parentNode) {
    state.overlay.parentNode.removeChild(state.overlay)
  }
  delete window.${PICK_GLOBAL}
  return true
})()`
}
