# Universal Project Picker — plan

## Problem
1. The new-chat screen shows the **project** badge but no **group** affordance — and chats
   created via a group's `+` never refresh badges after the membership is added
   (`newChatInGroup` doesn't re-render the message view). So "project and group it will
   go into" is not reliably visible.
2. Choosing a project is a raw path prompt (`openAddProject`) or a small menu
   (`openProjectPicker`). There is no universal, searchable, browse-the-filesystem picker.

## Goals
- Empty-chat screen always shows `project · X` **and** `group · Y` (or `group · + Add`).
- Clicking project opens a **universal project picker modal**: search box, filesystem
  browser (child dirs at any level), breadcrumbs, Finder button.
- Same modal reused everywhere a folder is chosen (badge, Projects `+` header).
- Grayscale, keyboard-friendly, instant feel; no timers except debounced search (150ms).

## Design

### A. Badges (frontend only, `src/main.ts` + `src/style.css`)
- `chatContextBar()` always renders the group badge: member name, else `+ Add`
  (opens existing `openGroupPicker`).
- `newChatInGroup()` calls `renderSettled()` after adding membership so badges appear.
- No change to non-empty chats (badges stay create-time only — session cwd is immutable).

### B. Backend: `pi_list_dirs` (`src-tauri/src/main.rs`)
- New Tauri command `pi_list_dirs(path: String) -> Result<DirList, String>`.
- `DirList { path, parent: Option<String>, home: String, dirs: Vec<String> }`
  (full paths, dirs only, dot-dirs skipped, case-insensitive sort, cap 1000).
- Canonicalizes the path; errors become `Err(String)` shown as an inline row error.
- Register in `invoke_handler`. No new capabilities (Rust `std::fs` only, on demand).
- Unit test with a temp dir (no new deps).

### C. Picker modal (frontend)
- `openModal(title, build, { wide?: boolean })` — add optional wide variant
  (`.dialog-box.wide`, list scroll area). Backward compatible.
- `openProjectPickerModal(startDir, onPick)`:
  - Search input, dual-mode: plain text filters current level (150ms debounce);
    input starting with `/` or `~` + `Enter` jumps to that path (`~` via `home`).
  - Breadcrumb row: clickable segments from `/` to current; `↑` up affordance.
  - Rows: child dirs, single click descends (per-level result cache, no re-invoke
    on back-nav). `Enter` descends into the sole match.
  - Footer: `Browse in Finder…` (dialog plugin, directory mode → jumps browser
    there), `Cancel`, primary `Start chat here` (picks current dir).
  - Esc cancels (existing modal behavior). Full paths as row titles.
- `addProjectWithAncestors(dir)` extracted from `openAddProject`; both the picker
  and Projects `+` use the modal:
  - Badge: pick → `addProjectWithAncestors(dir)` + `newChatInProject(dir)`.
  - Projects `+` (`openAddProject`): pick → `addProjectWithAncestors(dir)` only.
    (The picker's path-jump replaces the old raw path prompt; Finder stays available
    inside the modal.)

### D. Non-goals
- No group modal (menu toggle stays). No recursive search across the whole disk
  (current-level filter + path jump only — fast, predictable). No sidebar changes.

## Verification
- `npx tsc --noEmit`, `npm test`, `cargo test` (new `pi_list_dirs` test), `vite build`.
- Live in dev: badge → picker → descend/jump/Finder → start chat; group badge add/remove.
- `?dev=1` suite: tsc-covered; no new headless checks (empty-state/badge flows need
  real backend state — verify live).
