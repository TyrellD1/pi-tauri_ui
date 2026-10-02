# UI/UX audit + delight pass — plan

Branch: `claude/trusting-tesla-v7660q` · Base: `main` @ 89ad149

Method: read every line of `index.html`, `src/style.css`, `src/main.ts`, `src/logic.ts`, and drove the real UI
through the dev preview (`?dev=1`) in headless Chromium, light and dark, across the Populated / Empty /
Streaming / Permissions scenarios. Findings are grouped as **bugs** (broken or wrong), **eye sores**
(works but looks off), and **delight** (new things that make the shell feel better). Every item keeps the
AGENTS.md rules: grayscale theme tokens only, no new deps, no polling or standing timers, CSS animations limited to
`transform` + `opacity`, reduced motion respected, keyboard first.

Legend: ✅ = shipped in this branch · ⏭ = considered, deferred (reason given)

---

## A. Bugs

| # | Where | Problem | Fix |
|---|---|---|---|
| A1 ✅ | Markdown links | `<a target="_blank">` does nothing in a Tauri webview. Every link pi prints is dead. | Delegate link clicks in the transcript to `plugin:opener\|open_url` (already granted by `opener:default`), with a `window.open` fallback for the browser preview. |
| A2 ✅ | Boot error state | The **Retry connection** button is appended outside `.empty-actions`, so it renders as an unstyled native browser button. | Put it in an `.empty-actions` row like the other empty-state buttons. |
| A3 ✅ | Jump to latest | Hard-coded `bottom: 178px`. When a permission card, queue bar, attachments or a tall draft grow the composer, the pill sits on top of them (or floats far above). | Anchor the pill to the composer wrapper (`bottom: 100%`), so it always sits just above whatever the composer is showing. |
| A4 ✅ | Context circle | With no usage yet, the ring draws a lone round-cap dot at 12 o'clock, which looks like a stalled spinner next to a real one. | No data → a quiet dashed ring with a "—" label. Data → the ring as before. |
| A5 ✅ | Global shortcuts | `⌘N` / `⌘,` / `⌘K` fire under an open modal (new chat starts behind the Rename dialog, for example). | Ignore app shortcuts while a modal is open. The modal owns the keyboard. |
| A6 ✅ | `openMenu` | Every anchored menu (group picker, sidebar right-click) sets `aria-expanded=true` on the header ⋯ button. | Only the header menu toggles the header button's state. |
| A7 ✅ | Attachment error | Each error arms its own 6s hide timer, so an older timer hides a newer error early. | One timer, re-armed per error. |
| A8 ✅ | Window title | The OS window or tab always says `pi` (unless an extension sets it), so ⌘-Tab and Mission Control can't tell chats apart. | `document.title = "<chat> — pi"`, plus a `●` prefix while a turn runs. An extension's `setTitle` still wins. |
| A9 ✅ | Header title | Long names truncate with no way to read them. The tooltip only says "Double-click to rename". | Tooltip shows the full name plus the rename hint. |
| A10 ✅ | Dead code and CSS | `.turn` selectors (no `.turn` nodes exist), the unused `tokenLine` text assembly, the unused `.loading-state`. | Remove them, or reuse them (skeleton, see C3). |
| A11 ✅ | Scrollbar thumb | The 2px `--page` border around the thumb shows as a white or black ring on the `--surface` sidebar. | Use a transparent border with `background-clip: padding-box`. |
| A12 ✅ | Non-mac hints | `⌘K` / `⌘,` are printed on Windows and Linux too. | Platform-aware modifier label (`Ctrl`). |

## B. Eye sores

| # | Where | Problem | Fix |
|---|---|---|---|
| B1 ✅ | Assistant blocks | Every prose block reserves a 30px row for a hover-only Copy button, so multi-part answers have large holes (very visible between a list and the next tool row). | Move Copy into the right gutter as an icon button, absolutely positioned, visible on hover or focus. It takes zero layout space. |
| B2 ✅ | Notices | Notices are inserted in normal flow above the transcript, so each one shoves the whole conversation down (layout shift). They also have a full text "Dismiss" button. | Floating toast stack (top-right of the chat pane) with an enter transition (opacity + translate), an ✕ icon, and auto-dismiss that pauses on hover. Errors stay sticky. |
| B3 ✅ | Empty state | The hero sits on a different left edge (520px centered box) than the transcript and composer column, so it looks misaligned. It also teaches very little. | Align it to the message column. Add more starter prompts and a row of keyboard tips (new chat, search, skills via `/`, attach). |
| B4 ✅ | Model select | `provider/model` is truncated mid-word at 200px ("opencode-go/muse-spark-1.3-c"). | Group options by provider (`<optgroup>`), show only the model id, and put the full id in the tooltip. |
| B5 ✅ | Selected chat | The selected row and a hovered row share the exact same background, so you can't tell which chat is open while hovering others. | Selected row gets a 2px `--strong` inset left bar and a slightly deeper fill. |
| B6 ✅ | Sidebar row badges | The spinner, dot and code badge float mid-row because the title doesn't flex. | Title flexes, so badges sit right beside the timestamp. |
| B7 ✅ | Confirm card | Three buttons (Cancel / No / Yes) for a yes/no question, and initial focus lands on Cancel with a heavy 2px black ring. | Keep Cancel reachable via Esc (with a hint) and drop the visible third button for `confirm`. Add **Y** / **N** keys, guarded for 400ms after the card appears so a keystroke already in flight can't answer it. Card-level focus, no ring flash. |
| B8 ✅ | Focus ring | A 2px pure-ink outline is heavy for a grayscale UI. | 2px `--quiet` ring with 2px offset. Still clearly visible in both themes. |
| B9 ✅ | Tool rows | The summary is one muted string, the lead verb isn't distinguished, and paths and commands aren't monospace. A running tool's dot looks the same as a finished one. | Lead verb in ink weight 500. Target in mono. The running dot pulses (opacity only). |
| B10 ✅ | Composer hint | "Enter sends · ⇧↵ newline · Esc stops" is shown permanently, even when nothing can be stopped. | Context-aware: idle shows "↵ send · ⇧↵ newline · / skills". Running shows "↵ steer · Esc stop". |
| B11 ✅ | Placeholder | It always says "Message pi…", even mid-run, when Enter actually *steers*. | Running placeholder: "Steer pi… (or queue a follow-up with ◷)". |
| B12 ✅ | Surfaces pop in | Modals, menus and popovers appear with no transition, which is jarring next to otherwise quiet chrome. | 120ms opacity + 4px translate/scale-in. Disabled under reduced motion. |

## C. Delight

| # | Feature | Notes |
|---|---|---|
| C1 ✅ | **Live tail indicator** | While a turn runs, a slim "● ● ● Thinking… / Running bash…" line sits at the end of the transcript, so it's obvious pi is working even before the first token. Pure CSS opacity pulse, removed on settle. Zero timers. |
| C2 ✅ | **Streaming caret** | A soft caret follows the text that is streaming right now (the existing unused `.caret` style). It is CSS-only and removed when the stream settles. |
| C3 ✅ | **Skeleton boot** | "Starting pi…" becomes a shimmer-free skeleton of message lines (AGENTS: no spinners where a skeleton will do). |
| C4 ✅ | **Inline rename** | Double-click the header title (or ⌘R / the menu item) to edit it in place. Enter saves, Esc cancels, blur saves. No modal. |
| C5 ✅ | **Sidebar toggle** | ⌘B (or the header button) collapses the sidebar into a focus mode. The choice persists, and a header button brings it back. |
| C6 ✅ | **Search that drives** | `↓` from search moves into the results, `Enter` opens the first match, `Esc` clears the search and returns to the composer. There's an inline ✕ clear button, and the hint hides while typing. |
| C7 ✅ | **Recall last message** | `↑` in an empty composer pulls back your last sent message for editing, like a shell. |
| C8 ✅ | **Attach button** | A paperclip in the composer opens the native image picker. Paste and drag still work. The drag-over state shows a "Drop images to attach" overlay instead of only a border tint. |
| C9 ✅ | **Shortcut sheet** | `⌘/` opens a cheat sheet of every shortcut, and the Settings modal links to it. |
| C10 ✅ | **Real Settings** | Settings grows from one text field into: Appearance (System / Light / Dark segmented control), Transcript (show tool activity, quiet mode), Project folder (with a Browse… button that opens the folder picker), and shortcuts. |
| C11 ✅ | **Actionable toasts** | "Finished in X" gets an **Open** button that jumps to that chat. |
| C12 ✅ | **Message actions** | User bubbles get a gutter Copy, plus an **Edit** action that puts the text back in the composer. Hovering a bubble shows its send time. |
| C13 ✅ | **Header breadcrumb** | The header shows `project ›` before the chat title, so the folder context is always visible. Clicking it opens the project picker. |
| C14 ✅ | **Thinking summary** | The "Thinking" disclosure shows its length ("Thinking · 120 words") so you know whether it's worth opening. |

## D. Deferred (and why)

- ⏭ **Virtualized transcript.** Needs a measurement layer. Today's keyed renderer already avoids re-render storms, so the cost and benefit don't justify it in a UI pass.
- ⏭ **Syntax highlighting.** AGENTS allows a lazy `IntersectionObserver` version, but any real highlighter is a >10KB dependency. That needs its own justification and PR.
- ⏭ **Message timestamps inline.** Shown on hover only (C12) to keep the column quiet.
- ⏭ **Per-chat model memory.** It needs backend semantics (`set_model` fans out to all processes by design).

## Verification

- `npm run build` (tsc + vite) and `npm test` stay green.
- The dev-preview **Run UI regression** suite stays green, with selectors updated only where markup intentionally changed.
- Before and after screenshots in both themes (Populated / Empty / Streaming / Permissions).
- The bundle stays well under the 300KB target.
