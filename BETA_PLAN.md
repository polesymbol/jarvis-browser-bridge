# Free Beta Launch Plan — Jarvis Browser Bridge

*Draft for Pratik's yes/no. Nothing here is committed or published until he approves.*

## Where we are

v1 private is done and verified working: one banner approval → action executes in ~5s, consent enforced locally, everything audited. The locked sequence says: **build v1 → Pratik private use → free beta (metrics defined before launch) → pilot/design partnership proposal (no split named)**. This plan is the beta step.

## 0. Pre-launch security checklist (must clear before any tester touches it)

| Item | State | Owner |
|---|---|---|
| Rotate connector key + reconnect (test keys were pasted in chat) | ⬜ pending | Pratik |
| Revoke the short-lived GitHub PAT used for pushes (Settings → Developer settings → Tokens) — confirm even if you think it expired | ⬜ pending | Pratik |
| Repo secret scan | ✅ clean (checked 2026-10-11 — no keys or tokens in working tree) | done |
| Relay healthy, public, TLS | ✅ `wss://jbb-relay-production.up.railway.app` serving `/health` | done |
| Repo public, 10 commits, working tree clean | ✅ verified 2026-10-11 | done |

## 1. What we're measuring (from ARCHITECTURE.md §9 — defined before launch)

| Metric | How collected |
|---|---|
| Task success rate (completed / attempted) | Driver session logs + tester's weekly check-in |
| Consent allow / deny / revoke per tier | Audit-log export (opt-in diagnostics — user explicitly enables; no analytics SDKs, ever) |
| Abort / kill-switch (`Ctrl+Shift+K`) rate | Audit-log export |
| Injection-heuristic triggers (true vs false positive, user-judged) | Audit-log export + weekly form |
| Sites covered, sessions per user, 7-day retention | Weekly check-in form |
| Trust score — "did you feel in control?" (1–5) | Weekly form |
| Support burden per tester (min/week) | Our own time log |

These metrics are the proposal's evidence. No metrics, no proposal.

## 2. Testers

- **Wave 1:** 5 people from Pratik's own circle (people he trusts with an honest "this broke" report).
- **Wave 2:** expand to 20–50 per ARCHITECTURE.md §8.
- Hard rules: **fresh Chrome profile only** (no saved passwords, no bank details — login itself is consent); banking/financial sites blocked by default in beta; uninstall instructions on day one.

## 3. Onboarding (one page, baby steps)

1. Install: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
2. Open the side panel → paste relay URL → Generate key → Connect.
3. Consent tour: panel card / top-center banner / notification — approve once from each.
4. Kill switch: `Ctrl+Shift+K`. Audit tab: where every decision lives.
5. Enable opt-in diagnostics if willing (audit-log export, weekly 2-min form).

## 4. Honest beta terms (say it upfront, it's the differentiator)

- The extension executes only what you approve; a compromised relay can't skip consent (enforcement is local).
- Prompt-injection heuristics are a speed bump, not a wall — T3 actions (auth, payments, email, publishing, deletion) always ask.
- The relay operator can technically observe traffic passing through (stores nothing; TLS ends there). E2E-encrypted payloads are the planned v2 answer.
- Beta is free; participation = helping prove the trust model. Legal review before any public step.

## 5. Cadence

- Weekly 15-min metric review (same discipline as the consulting scorecard).
- Kill criteria: trust score < 3.5 after wave 1, or support burden > 30 min/tester/week → pause and harden before wave 2.
- Decision gate: metrics package + security review → pilot/design partnership proposal.

## Decisions needed from Pratik

1. Yes/no on this plan (or his edits).
2. The 5 wave-1 names.
3. Keep the relay on Railway for beta, or move to the small VPS early?

---
*Drafted 2026-10-11 by Jarvis. Not committed to the repo — approval first.*
