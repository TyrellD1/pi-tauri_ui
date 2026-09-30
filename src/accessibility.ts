// Shared focus behavior for modal surfaces and image controls. No polling.
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter(el => !el.matches(':disabled, [tabindex="-1"]') && !el.closest('[inert], [hidden], .hidden') && el.getClientRects().length > 0);
}
export function trapFocus(event: KeyboardEvent, root: HTMLElement) {
  if (event.key !== 'Tab') return;
  const items = focusableWithin(root), first = items[0], last = items[items.length - 1];
  if (!first) { event.preventDefault(); root.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}
export function makeImageZoomable(img: HTMLImageElement) {
  if (img.dataset.zoomReady) return;
  img.dataset.zoomReady = 'true';
  img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-expanded', 'false');
  const label = img.alt || 'Image';
  img.setAttribute('aria-label', `Expand ${label}`);
  const toggle = () => {
    const expanded = img.classList.toggle('full');
    img.setAttribute('aria-expanded', String(expanded));
    img.setAttribute('aria-label', `${expanded ? 'Shrink' : 'Expand'} ${label}`);
  };
  img.addEventListener('click', toggle);
  img.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); }
  });
}
