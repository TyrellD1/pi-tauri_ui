import { trapFocus } from './accessibility';

// Sidebar state is independent from chat/process state. Media and DOM events only.
export function initNavigation() {
  const app = document.getElementById('app')!;
  const sidebar = document.getElementById('sidebar')!;
  const main = document.getElementById('main')!;
  const toggle = document.getElementById('btn-sidebar')!;
  const close = document.getElementById('btn-close-sidebar')!;
  const backdrop = document.getElementById('sidebar-backdrop')!;
  const modal = document.getElementById('modal-root')!;
  const narrow = matchMedia('(max-width: 760px)');
  let desktopOpen = true, drawerOpen = false;
  try { desktopOpen = localStorage.getItem('pi-sidebar-hidden') !== '1'; } catch { /* session-only */ }
  const sync = () => {
    const open = narrow.matches ? drawerOpen : desktopOpen;
    const hasModal = modal.childElementCount > 0;
    app.dataset.sidebar = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Hide chats' : 'Show chats');
    sidebar.inert = !open || hasModal;
    main.inert = (narrow.matches && open) || hasModal;
    backdrop.classList.toggle('hidden', !narrow.matches || !open);
    if (narrow.matches && open) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
  };
  const setOpen = (open: boolean, focus = true) => {
    if (narrow.matches) drawerOpen = open;
    else {
      desktopOpen = open;
      try { localStorage.setItem('pi-sidebar-hidden', open ? '0' : '1'); } catch { /* session-only */ }
    }
    sync();
    if (focus) (open ? sidebar.querySelector<HTMLElement>('#search') : toggle)?.focus();
  };
  toggle.onclick = () => setOpen(app.dataset.sidebar !== 'open');
  close.onclick = () => setOpen(false);
  backdrop.onclick = () => setOpen(false);
  sidebar.addEventListener('keydown', e => {
    if (!narrow.matches || !drawerOpen || modal.childElementCount || document.getElementById('menu-root')!.childElementCount) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else trapFocus(e, sidebar);
  });
  narrow.addEventListener('change', () => {
    const wasInside = sidebar.contains(document.activeElement);
    drawerOpen = false; sync();
    if (wasInside && sidebar.inert) toggle.focus();
  });
  new MutationObserver(sync).observe(modal, {childList:true});
  sync();
  return {
    sync,
    show: () => setOpen(true),
    toggle: () => setOpen(app.dataset.sidebar !== 'open'),
    closeDrawer: () => { if (narrow.matches && drawerOpen) setOpen(false, false); },
  };
}
