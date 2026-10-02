// Command-style picker: a trigger button that opens a searchable, grouped
// popover list. Controlled — the owner holds the truth and pushes it in with
// setState(); a pick only reports through onChange and never changes the
// shown value by itself. That keeps optimistic updates and rollbacks (a
// rejected set_model, a state refresh from pi) in one place: the owner.

export interface PickerItem {
  value: string;
  label: string;
  group?: string;
  hint?: string;
  title?: string;
}
export interface PickerState {
  items: PickerItem[];
  value: string | null;
  disabled: boolean;
}
export interface PickerOptions {
  id: string;
  label: string;
  searchPlaceholder: string;
  emptyText: string;
  onChange: (value: string) => void;
}
export interface Picker {
  trigger: HTMLButtonElement;
  setState: (next: Partial<PickerState>) => void;
  readonly state: Readonly<PickerState>;
  open: () => void;
  close: (restoreFocus?: boolean) => void;
  isOpen: () => boolean;
}

/** Every whitespace-separated query token must appear in label, group or value. */
export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((it) => {
    const hay = `${it.label} ${it.group ?? ""} ${it.value} ${it.hint ?? ""}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

const CHEV = `<svg class="pk-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const SEARCH = `<svg class="pk-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>`;

let openPicker: Picker | null = null;

export function createPicker(opts: PickerOptions): Picker {
  let state: PickerState = { items: [], value: null, disabled: false };
  let pop: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let listEl: HTMLElement | null = null;
  let shown: PickerItem[] = [];
  let active = 0;
  let outside: ((e: MouseEvent) => void) | null = null;
  const listId = `${opts.id}-list`;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = opts.id;
  trigger.className = "picker-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="pk-kicker"></span><span class="pk-value"></span>${CHEV}`;
  (trigger.querySelector(".pk-kicker") as HTMLElement).textContent = opts.label;
  const valueEl = trigger.querySelector(".pk-value") as HTMLElement;

  function current(): PickerItem | undefined {
    return state.items.find((i) => i.value === state.value);
  }
  function renderTrigger() {
    const cur = current();
    const text = cur?.label ?? (state.items.length ? "Choose…" : opts.emptyText);
    if (valueEl.textContent !== text) valueEl.textContent = text;
    const full = cur ? cur.title ?? (cur.group ? `${cur.group}/${cur.label}` : cur.label) : text;
    trigger.title = `${opts.label}: ${full}`;
    trigger.setAttribute("aria-label", `${opts.label}: ${full}. Activate to change.`);
    trigger.disabled = state.disabled;
  }

  function setActive(i: number, scroll = true) {
    if (!listEl || !shown.length) return;
    active = Math.max(0, Math.min(shown.length - 1, i));
    for (const el of listEl.querySelectorAll<HTMLElement>(".pk-item")) {
      const on = Number(el.dataset.idx) === active;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", String(on));
      if (on) {
        input?.setAttribute("aria-activedescendant", el.id);
        if (scroll) el.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function renderList() {
    if (!listEl) return;
    shown = filterItems(state.items, input?.value ?? "");
    listEl.replaceChildren();
    if (!shown.length) {
      const e = document.createElement("div");
      e.className = "pk-empty";
      e.textContent = state.items.length ? "No matches" : opts.emptyText;
      listEl.appendChild(e);
      return;
    }
    let group: string | undefined = "\u0000";
    shown.forEach((it, idx) => {
      if (it.group !== group) {
        group = it.group;
        if (group) {
          const h = document.createElement("div");
          h.className = "pk-group";
          h.setAttribute("role", "presentation");
          h.textContent = group;
          listEl!.appendChild(h);
        }
      }
      const row = document.createElement("div");
      row.className = "pk-item" + (it.value === state.value ? " selected" : "");
      row.id = `${opts.id}-opt-${idx}`;
      row.dataset.idx = String(idx);
      row.setAttribute("role", "option");
      if (it.title) row.title = it.title;
      const check = document.createElement("span");
      check.className = "pk-check";
      if (it.value === state.value) check.innerHTML = CHECK;
      const lab = document.createElement("span");
      lab.className = "pk-label";
      lab.textContent = it.label;
      row.append(check, lab);
      if (it.hint) {
        const h = document.createElement("span");
        h.className = "pk-hint";
        h.textContent = it.hint;
        row.appendChild(h);
      }
      row.addEventListener("mousemove", () => { if (active !== idx) setActive(idx, false); });
      row.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in search
      row.addEventListener("click", () => choose(idx));
      listEl!.appendChild(row);
    });
    const sel = shown.findIndex((i) => i.value === state.value);
    setActive(input?.value ? 0 : Math.max(0, sel));
  }

  function choose(idx: number) {
    const it = shown[idx];
    if (!it) return;
    close(true);
    if (it.value !== state.value) opts.onChange(it.value);
  }

  function position() {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const pad = 8, gap = 6;
    const w = Math.min(320, window.innerWidth - pad * 2);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(pad, Math.min(r.left, window.innerWidth - w - pad))}px`;
    const below = r.top < window.innerHeight / 2;
    const room = below ? window.innerHeight - r.bottom - gap - pad : r.top - gap - pad;
    pop.style.maxHeight = `${Math.max(160, Math.min(380, room))}px`;
    if (below) { pop.style.top = `${r.bottom + gap}px`; pop.style.bottom = "auto"; pop.classList.add("below"); }
    else { pop.style.bottom = `${window.innerHeight - r.top + gap}px`; pop.style.top = "auto"; pop.classList.remove("below"); }
  }

  function open() {
    if (state.disabled || pop) return;
    openPicker?.close(false);
    pop = document.createElement("div");
    pop.className = "picker-pop";
    const search = document.createElement("div");
    search.className = "pk-search";
    search.innerHTML = SEARCH;
    input = document.createElement("input");
    input.type = "text";
    input.placeholder = opts.searchPlaceholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-label", opts.searchPlaceholder);
    search.appendChild(input);
    listEl = document.createElement("div");
    listEl.className = "pk-list";
    listEl.id = listId;
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", opts.label);
    pop.append(search, listEl);
    document.body.appendChild(pop);
    input.addEventListener("input", renderList);
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const page = 8;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1 >= shown.length ? 0 : active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1 < 0 ? shown.length - 1 : active - 1); }
      else if (e.key === "PageDown") { e.preventDefault(); setActive(active + page); }
      else if (e.key === "PageUp") { e.preventDefault(); setActive(active - page); }
      else if (e.key === "Home" && !input!.value) { e.preventDefault(); setActive(0); }
      else if (e.key === "End" && !input!.value) { e.preventDefault(); setActive(shown.length - 1); }
      else if (e.key === "Enter") { e.preventDefault(); choose(active); }
      else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (input!.value) { input!.value = ""; renderList(); } else close(true);
      } else if (e.key === "Tab") close(false);
    });
    outside = (e: MouseEvent) => {
      if (pop && !pop.contains(e.target as Node) && !trigger.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", onResize);
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("open");
    openPicker = api;
    renderList();
    position();
    input.focus();
  }
  function onResize() { position(); }

  function close(restoreFocus = true) {
    if (!pop) return;
    pop.remove();
    pop = null; input = null; listEl = null; shown = [];
    if (outside) document.removeEventListener("mousedown", outside);
    outside = null;
    window.removeEventListener("resize", onResize);
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("open");
    if (openPicker === api) openPicker = null;
    if (restoreFocus && !trigger.disabled) trigger.focus();
  }

  trigger.addEventListener("click", () => (pop ? close(true) : open()));
  trigger.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !pop) { e.preventDefault(); open(); }
  });

  const api: Picker = {
    trigger,
    get state() { return state; },
    setState(next) {
      state = { ...state, ...next };
      renderTrigger();
      if (state.disabled && pop) close(false);
      else if (pop) renderList();
    },
    open,
    close,
    isOpen: () => !!pop,
  };
  renderTrigger();
  return api;
}
