/**
 * Every string this module produces is evaluated inside an untrusted guest
 * page, so nothing here may touch Electron and every agent-supplied value is
 * encoded rather than concatenated. Keeping the injected JavaScript in one
 * pure module is what lets it be executed against a real DOM in tests.
 */

export const BROWSER_REFS_GLOBAL = "__chathubRefs"

export type SnapshotFilter = "interactive" | "all"

export type SnapshotScriptOptions = {
  filter: SnapshotFilter
  limit: number
}

const NAME_CHAR_LIMIT = 120

function jsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function jsNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.trunc(value)) : "0"
}

const HELPERS = `
  var chathubDoc = function (el) {
    return el.ownerDocument || document
  }
  var chathubView = function (el) {
    var doc = chathubDoc(el)
    return doc.defaultView || window
  }
  var chathubStyle = function (el) {
    var view = chathubView(el)
    try {
      return view.getComputedStyle ? view.getComputedStyle(el) : null
    } catch (err) {
      return null
    }
  }
  var chathubRect = function (el) {
    try {
      return el.getBoundingClientRect ? el.getBoundingClientRect() : null
    } catch (err) {
      return null
    }
  }
  var chathubVisible = function (el) {
    if (!el || el.nodeType !== 1) return false
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false
    if (el.hasAttribute && el.hasAttribute("hidden")) return false
    var style = chathubStyle(el)
    if (style) {
      if (style.display === "none") return false
      if (style.visibility === "hidden" || style.visibility === "collapse") return false
    }
    var doc = chathubDoc(el)
    var isRoot = el === doc.body || el === doc.documentElement
    var isFixed = style ? style.position === "fixed" : false
    if (!isRoot && !isFixed && el.offsetParent === null) return false
    return true
  }
  var chathubHasSize = function (el) {
    var rect = chathubRect(el)
    if (!rect) return true
    return rect.width > 0 || rect.height > 0
  }
  var chathubCollapse = function (value) {
    return String(value == null ? "" : value).replace(/\\s+/g, " ").trim()
  }
  var chathubTextOf = function (el) {
    var raw = typeof el.innerText === "string" ? el.innerText : el.textContent
    return chathubCollapse(raw)
  }
  var chathubResolveRef = function (ref) {
    var match = /^ref_([1-9][0-9]*)$/.exec(String(ref))
    if (!match) return null
    var refs = window.${BROWSER_REFS_GLOBAL}
    if (!refs || typeof refs.length !== "number") return null
    var el = refs[Number(match[1]) - 1]
    if (!el || el.nodeType !== 1) return null
    if (el.isConnected === false) return null
    return el
  }
`

const SNAPSHOT_TAXONOMY = `
  var SKIP_TAGS = { script: 1, style: 1, noscript: 1, template: 1, head: 1 }
  var HEADING_TAGS = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 }
  var LANDMARK_TAGS = { nav: 1, main: 1, header: 1, footer: 1, form: 1 }
  var STRUCTURE_ROLES = {
    nav: 1, main: 1, header: 1, footer: 1, form: 1,
    listitem: 1, table: 1, image: 1, iframe: 1,
  }
  var CLICKABLE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, option: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, combobox: 1,
    textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, treeitem: 1,
  }
`

const SNAPSHOT_NODE_BUILDERS = `
  var roleFor = function (el, tag) {
    var explicit = el.getAttribute("role")
    if (explicit) return chathubCollapse(explicit).split(" ")[0] || "generic"
    if (tag === "a") return "link"
    if (tag === "button") return "button"
    if (tag === "input") {
      var type = String(el.getAttribute("type") || "text").toLowerCase()
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "button" || type === "submit" || type === "reset") return "button"
      return "textbox"
    }
    if (tag === "textarea") return "textbox"
    if (tag === "select") return "combobox"
    if (tag === "img") return "image"
    if (tag === "iframe") return "iframe"
    if (HEADING_TAGS[tag]) return "heading"
    if (LANDMARK_TAGS[tag]) return tag
    if (tag === "li") return "listitem"
    if (tag === "table") return "table"
    if (el.isContentEditable) return "textbox"
    return ownTextOf(el) ? "text" : "generic"
  }

  var ownTextOf = function (el) {
    var parts = []
    var children = el.childNodes || []
    for (var i = 0; i < children.length; i += 1) {
      if (children[i].nodeType === 3) parts.push(children[i].nodeValue)
    }
    return chathubCollapse(parts.join(" "))
  }

  var labelTextOf = function (el) {
    var doc = chathubDoc(el)
    var id = el.getAttribute("id")
    if (id) {
      try {
        var forLabel = doc.querySelector('label[for="' + String(id).replace(/"/g, '\\\\"') + '"]')
        if (forLabel) return chathubTextOf(forLabel)
      } catch (err) {
        /* selector built from a hostile id */
      }
    }
    var closest = el.closest ? el.closest("label") : null
    return closest ? chathubTextOf(closest) : ""
  }

  var nameFor = function (el, tag) {
    var candidates = [
      el.getAttribute("aria-label"),
      el.getAttribute("alt"),
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
    ]
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = chathubCollapse(candidates[i])
      if (candidate) return candidate.slice(0, ${NAME_CHAR_LIMIT})
    }
    var own = tag === "iframe" ? "" : chathubTextOf(el)
    if (own) return own.slice(0, ${NAME_CHAR_LIMIT})
    return labelTextOf(el).slice(0, ${NAME_CHAR_LIMIT})
  }

  var valueFor = function (el, tag, role) {
    if (role === "checkbox" || role === "radio") return undefined
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return undefined
    var value = typeof el.value === "string" ? el.value : ""
    if (tag === "input" && String(el.getAttribute("type") || "").toLowerCase() === "password") {
      return value ? new Array(value.length + 1).join("\\u2022") : ""
    }
    return value.slice(0, ${NAME_CHAR_LIMIT})
  }

  var isInteractive = function (el, tag, role) {
    if (tag === "a") return el.hasAttribute("href")
    if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") return true
    if (el.getAttribute("role") && CLICKABLE_ROLES[role]) return true
    if (el.hasAttribute("onclick")) return true
    var tabIndex = el.getAttribute("tabindex")
    if (tabIndex !== null && chathubCollapse(tabIndex) !== "-1") return true
    if (el.isContentEditable) return true
    return false
  }
`

/**
 * Walks the guest DOM into a ref-tagged tree. The refs array it leaves on
 * `window` is the only state a later op needs, and it is replaced wholesale on
 * every snapshot so a stale ref can never point at the wrong element.
 */
export function snapshotScript(options: SnapshotScriptOptions): string {
  const filter: SnapshotFilter = options.filter === "all" ? "all" : "interactive"
  const limit = Math.max(1, Math.trunc(options.limit) || 1)
  return `(function () {
${HELPERS}
${SNAPSHOT_TAXONOMY}
${SNAPSHOT_NODE_BUILDERS}
  var wantAll = ${filter === "all" ? "true" : "false"}
  var limit = ${jsNumber(limit)}
  var refs = []
  window.${BROWSER_REFS_GLOBAL} = refs
  var nodes = []
  var truncated = false

  var shouldEmit = function (el, tag, role) {
    if (tag === "iframe") return true
    if (role === "heading") return true
    if (isInteractive(el, tag, role)) return true
    if (!wantAll) return false
    if (STRUCTURE_ROLES[role]) return true
    return role === "text"
  }

  var emit = function (el, tag, role, depth) {
    var node = { ref: "ref_" + (refs.length + 1), role: role, name: nameFor(el, tag), depth: depth }
    var value = valueFor(el, tag, role)
    if (value !== undefined) node.value = value
    if (role === "checkbox" || role === "radio") node.checked = el.checked === true
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") node.disabled = true
    refs.push(el)
    nodes.push(node)
  }

  var walk = function (el, depth) {
    if (truncated) return
    var tag = el.tagName ? String(el.tagName).toLowerCase() : ""
    if (SKIP_TAGS[tag]) return
    if (!chathubVisible(el)) return
    var role = roleFor(el, tag)
    var childDepth = depth
    if (shouldEmit(el, tag, role) && chathubHasSize(el)) {
      if (nodes.length >= limit) {
        truncated = true
        return
      }
      emit(el, tag, role, depth)
      childDepth = depth + 1
    }
    if (tag === "iframe") {
      try {
        var inner = el.contentDocument
        var innerRoot = inner ? inner.body || inner.documentElement : null
        if (innerRoot) walk(innerRoot, childDepth)
      } catch (err) {
        /* a cross-origin frame stays a single node */
      }
      return
    }
    var children = el.children || []
    for (var i = 0; i < children.length; i += 1) {
      walk(children[i], childDepth)
      if (truncated) return
    }
  }

  var root = document.body || document.documentElement
  if (root) walk(root, 0)
  return {
    url: String(location.href),
    title: String(document.title || ""),
    nodes: nodes,
    truncated: truncated,
  }
})()`
}

export function viewportScript(): string {
  return `(function () {
  return {
    width: Math.max(1, window.innerWidth || 0),
    height: Math.max(1, window.innerHeight || 0),
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
  }
})()`
}

/** Viewport-relative CSS pixels, scrolled into view first so a click lands. */
export function rectScript(ref: string): string {
  return `(function () {
${HELPERS}
  var el = chathubResolveRef(${jsString(ref)})
  if (!el) return null
  var measure = function () {
    var rect = chathubRect(el)
    if (!rect) return null
    var width = window.innerWidth || 0
    var height = window.innerHeight || 0
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      inViewport:
        rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width,
    }
  }
  var first = measure()
  if (!first) return null
  if (!first.inViewport && el.scrollIntoView) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch (err) {
      el.scrollIntoView()
    }
    return measure() || first
  }
  return first
})()`
}

export function focusScript(ref: string): string {
  return `(function () {
${HELPERS}
  var el = chathubResolveRef(${jsString(ref)})
  if (!el) return { ok: false, tag: "", type: null }
  var tag = String(el.tagName || "").toLowerCase()
  var type = el.getAttribute ? el.getAttribute("type") : null
  if (typeof el.focus === "function") {
    try {
      el.focus({ preventScroll: false })
    } catch (err) {
      el.focus()
    }
  }
  if ((tag === "input" || tag === "textarea") && typeof el.select === "function") {
    try {
      el.select()
    } catch (err) {
      /* a date or colour input refuses selection */
    }
  }
  var doc = chathubDoc(el)
  return { ok: doc.activeElement === el, tag: tag, type: type }
})()`
}

/**
 * Writes through the native value setter first: React installs its own setter
 * on the instance, and only the prototype one leaves its tracker out of date
 * enough for the dispatched `input` event to be believed.
 */
export function fillScript(ref: string, value: string): string {
  return `(function () {
${HELPERS}
  var el = chathubResolveRef(${jsString(ref)})
  if (!el) return { ok: false, kind: "unknown" }
  var next = ${jsString(value)}
  var tag = String(el.tagName || "").toLowerCase()
  var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase()
  var fire = function (name) {
    try {
      el.dispatchEvent(new Event(name, { bubbles: true }))
    } catch (err) {
      /* an ancient guest without the Event constructor */
    }
  }
  var writeValue = function (target, text) {
    var proto =
      typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null
    var descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null
    if (descriptor && descriptor.set) descriptor.set.call(target, text)
    else target.value = text
  }

  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    var want = next !== "" && next !== "false" && next !== "0" && next !== "off"
    if (type === "radio") {
      if (want && !el.checked && typeof el.click === "function") el.click()
      else {
        fire("input")
        fire("change")
      }
      return { ok: el.checked === want || !want, kind: "radio" }
    }
    if (el.checked !== want && typeof el.click === "function") el.click()
    else {
      fire("input")
      fire("change")
    }
    return { ok: el.checked === want, kind: "checkbox" }
  }

  if (tag === "select") {
    writeValue(el, next)
    if (el.value !== next) {
      var options = el.options || []
      for (var i = 0; i < options.length; i += 1) {
        if (chathubCollapse(options[i].textContent) === chathubCollapse(next)) {
          el.selectedIndex = i
          break
        }
      }
    }
    fire("input")
    fire("change")
    return { ok: true, kind: "select" }
  }

  if (tag === "input" || tag === "textarea") {
    writeValue(el, next)
    fire("input")
    fire("change")
    return { ok: el.value === next, kind: tag === "textarea" ? "textarea" : "input" }
  }

  if (el.isContentEditable) {
    el.textContent = next
    fire("input")
    fire("change")
    return { ok: true, kind: "contenteditable" }
  }

  return { ok: false, kind: "unknown" }
})()`
}

export function textScript(limit: number): string {
  return `(function () {
${HELPERS}
  var limit = ${jsNumber(Math.max(1, Math.trunc(limit) || 1))}
  var root =
    document.querySelector("main") || document.querySelector("article") || document.body
  if (!root) return { text: "", truncated: false }
  var raw = typeof root.innerText === "string" ? root.innerText : root.textContent
  var cleaned = String(raw || "")
    .replace(/[ \\t]+/g, " ")
    .replace(/ *\\n */g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim()
  return { text: cleaned.slice(0, limit), truncated: cleaned.length > limit }
})()`
}

export function waitForScript(selector: string): string {
  return `(function () {
${HELPERS}
  var found = null
  try {
    found = document.querySelector(${jsString(selector)})
  } catch (err) {
    return false
  }
  if (!found) return false
  return chathubVisible(found) && chathubHasSize(found)
})()`
}
