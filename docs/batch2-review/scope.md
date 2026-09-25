# Batch 2 adversarial review — scope

- Mode: plan. Target: docs/batch2-plan.md v1 (sha256 b8c04b97f0224432df15fad5094855bfab48050aa4b3fde4da435ad19d85bc4a), repo @ 7e66058.
- Lead app: pi (this session). Reviewer app: cursor. Requested model/effort: grok-4.7-high. Depth: 2.
- No effort override. Review folder: docs/batch2-review/.

## Round log
- R1: brief-r1.txt → cursor ask (grok-4.7-high). Completed; verdict "revise then implement". 5 material + 4 suggestion findings → round1-raw.txt.
- R2: recheck of plan v2 → round2-raw.txt. Completed; verdict "unresolved": R1 fixes verified, 3 new material mis-specs (R2-F1..F3) accepted into plan v3.
- Depth exhausted after R2 (budget 2). The v3 lines are therefore implemented but UNREVIEWED — flagged inline in docs/batch2-plan.md and in report.md.

## Post-review implementation notes (not covered by the reviews)
- Every v3 line was implemented; see report.md for the decision table.
- Feedback round after the PR: path clicks never worked (detached-DOM `isConnected` guard) — found by browser QA, not by plan review; reduced-motion spinner exception; empty-cwd sidebar poisoning found in the same pass.
- Dev preview `?dev=1` starts with the UI regression green (46/46) on a clean profile.
