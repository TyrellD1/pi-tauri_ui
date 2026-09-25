# Batch 2 adversarial review — report

- Mode: plan. Lead: pi (this session). Reviewer: cursor, `grok-4.7-high` (requested; runtime model not reported by CLI — recorded as requested-only).
- Depth: 2 (exhausted). Rounds: R1 plan-v1 → R2 plan-v2 recheck.
- Targets: plan-v1 sha256 `b8c04b97…` (docs/batch2-review/plan-v1.md), plan-v2 sha256 `d7bdf63f…` (git hash at review time; reviewer did not recompute).
- Outcome: **unresolved** — R2 found 3 material mis-specifications (R2-F1..F3). The lead accepts all three and folds them into plan-v3, but v3 changes are UNREVIEWED (no passes remain). Implementation proceeds on v3 at the user's prior authorization ("then implement", simplest call).
- Round files: brief-r1.txt, round1-raw.txt (verbatim), brief-r2.txt, round2-raw.txt (verbatim), plan-v1.md, scope.md. No secrets encountered. No separate reviewer reasoning retained beyond final answers.

## Decision table

| ID | Reviewer finding / severity | Decision | Evidence or reason | Revision and recheck |
|---|---|---|---|---|
| R1-F1 material §7 | Rust can't assign groups (localStorage); no external caller | Accepted | `loadGroups/saveGroups` are webview-only; confirmed in src/main.ts | v2: `group` off Rust, frontend-side after path; R2 recheck: present ✓ |
| R1-F2 material §7+D1 | Badge unreadable if parser can't see names | Accepted | `parse_session_preview` reads `session_info` only; real files have `session` header | v2: D1 records shape + localStorage fallback; R2: present, retention gap → R2-F2 |
| R1-F3 material §5 | Early refresh may precede file visibility; guard placement | Accepted | `submit()` ignores `sessionFile`; settled refreshes projects not sessions | v2: adopt-on-accept + guarded refresh; R2: present but key/event underspec → R2-F1 |
| R1-F4 material §3 | `targetScope` retargets all scoped commands | Accepted | `visibleScope()` global override in src/main.ts | v2: direct invokeChecked with explicit scope; R2: holds, signature matches ✓ |
| R1-F5 material §4 | Collapse breaks Copy (`pre.textContent`) | Accepted | Copy handler reads full code text | v2: visual-only collapse; R2: present ✓ |
| R1-F6 suggestion §1 | No source for "last compaction" | Accepted (simplest) | Stats payload has tokens/cost/contextUsage only | v2: row dropped; R2: present ✓ |
| R1-F7 suggestion §1+§6 | Two owners of footer right | Accepted (simplest) | composer-foot layout in style.css | v2: circle header-only; R2: present + token-line margin note → folded into v3 §6 |
| R1-F8 suggestion §2+§6 | Use opener plugin; canonicalize cwd; git PATH | Accepted (simplest) | opener plugin already wired; Finder PATH lesson in `resolve_pi` | v2: present; cwd param missing → R2-F3 |
| R1-F9 suggestion §3 | `deriveTitle` raw slice | Accepted | 48-char slice, newlines possible | v2: whitespace-collapse; R2: present ✓ |
| R2-F1 material §5 | Adopting sessionFile splits `sessKey()` vs `pendingSend.owner`; pre-adopt events mistagged | Accepted | `sessKey` uses activePath; owner captured pre-adopt; `visibleKey()` `cwdkey:` vs event `cwd:file` | v3 §5: retarget owners on adopt; same-cwd events treated as view while activePath empty. UNREVIEWED |
| R2-F2 material §7+§5 | Coded chat never enters submit/settle → no refresh → group/coded-set reference unlisted path; group prune drops paths | Accepted | Item-5 refresh lives on submit path only; `refreshAllProjects` prunes groups vs scan | v3 §7: refresh first, write group/coded-set only for listed paths, same retention rule. UNREVIEWED |
| R2-F3 material §2 | `pi_open_path {path}` lacks cwd for inside-cwd check | Accepted | Scoped cmds get cwd from frontend; app proc cwd ≠ project | v3 §2: `pi_open_path {cwd, path}`. UNREVIEWED |
| R2-note §6 | `#token-line` keeps `margin-left:auto`; branch won't own right edge | Accepted | style.css:489 | v3 §6: branch takes that slot (or margin moves). UNREVIEWED |
| R2-note §7/opener | Opener Rust method name + returned-path equality + file-at-accept visibility unconfirmed | Open | Read-only review; D1-D3 + impl-time checks | Carried as implementation checks; opener method verified by cargo build |

## Coverage and gaps
Covered: plan v1+v2 vs src/main.ts, src/logic.ts, src-tauri/src/main.rs, index.html, style.css; idea-8 exclusion; protocol/dep/timer constraints. Gaps: no live pi RPC, no builds/tests, hashes not recomputed by reviewer, opener crate source unopened.

## Result
`unresolved` — 9/9 R1 items verified fixed in v2; 3 new R2 material items accepted into v3 unreviewed. Implementation proceeds on docs/batch2-plan.md v3 explicitly carrying that caveat.
