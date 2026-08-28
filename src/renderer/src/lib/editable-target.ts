export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true
  const editableHost = target.closest(
    '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  )
  return editableHost !== null
}
