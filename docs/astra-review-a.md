# Astra UI review A

Completed 2026-09-19. Implements `docs/astra-steer-a`.

The first pi round established the quieter grayscale layout. Review found broken rejection handling, unstable streaming, lost permission requests, and inaccessible older chats. The second pi round was interrupted by repeated provider 503s. After the user authorized direct completion, Codex finished the refactor and reviewed the actual UI, not the original static mockup.

## Result

- Open assistant prose, restrained user messages, consistent typography and column alignment.
- Quiet header menu, labeled project selector, compact composer controls, one activity status. Usage details live in Session details.
- Stable ordered message/content blocks, authoritative final messages, one disclosure per tool call, retained focus/selection/output scroll.
- Rejected sends keep their own retryable snapshot without overwriting newer drafts. Sending, steering, follow-ups, Stop, IME composition and menu Escape have separate behavior.
- Per-chat text and attachment drafts; safe session navigation; one folder respawn; listener retry and reconnect recovery.
- Permission requests retain their IDs across notifications and queued requests. Failed responses remain explicitly retryable.
- All sessions remain searchable through bounded 100-row pages. Tool output offers full output after its initial 200-line view.
- Safe Markdown tables, links, code and raw-HTML escaping. No runtime dependency or idle polling added.

## Evidence

- Frontend typecheck and production build pass, roughly 49 kB total JavaScript before gzip.
- 41 helper/controller/production checks and 2 Rust tests pass.
- 35 integrated UI checks pass through the actual `main.ts` event and interaction paths, including rejection, retry, duplicate sends, node stability, permission races, queue semantics, attachment-only drafts, failed navigation, pagination/search, listener retry and reconnect.
- Populated UI inspected in light and dark at 1180×760 and 860×560. Permission controls remain reachable at minimum size. Screenshots captured in the supervising task.
- Packaged native app connected to the installed `pi --mode rpc` harness, displayed the configured Muse Spark contributor model at xhigh, switched into the real project, and loaded a real conversation with its image and tool history. No paid model prompt was submitted during native smoke testing.
- Native app and macOS disk-image build pass with macOS packaging access. A sandboxed disk-image attempt failed; retry with the required access succeeded.
- Preview controls and fixtures are excluded from production bundles.

## Scope and limits

Image drafts persist during the current app run; text drafts also survive restarts. Markdown is a deliberately small renderer, not a complete CommonMark implementation. Live streaming and failure cases were checked using deterministic local transport events; native smoke testing used real session reads without starting another model turn. The external provider's intermittent 503 availability is unchanged.

Changes were reviewed in isolation before conflict-checked integration into the original checkout. The original checkout had no concurrent tracked edits at integration time. The obsolete duplicated static preview is not part of the delivered app.
