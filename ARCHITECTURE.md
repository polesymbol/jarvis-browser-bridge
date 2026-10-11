# Browser Control Extension — v1 Build Architecture

**Working name:** Jarvis Browser Bridge (v1)
**Date:** 2026-10-10
**Status:** Debate concluded. Build authorized.

---

## 0. Locked decisions (from debate)

1. **Option (b):** the extension drives the user's own logged-in Chrome. The agent comes to the browser; credentials never leave it.
2. **Root problem:** Jarvis's VM uses a data-center IP → Cloudflare human-verification blocks on large parts of the web. The user's local Chrome (residential IP + real browser fingerprint) kills that failure class.
3. **Sequence:** build v1 → private use (Pratik) → free beta (validation data) → proposal to the Muse team as a **pilot/design partnership** (no revenue split named, no price dictated).
4. **Safety rule:** users must run a **fresh Chrome profile** — no saved bank details, no sensitive data. Login itself is the consent mechanism: the user logs into only what they want automated.
5. **Differentiator:** not better button-clicking (giants own that) — the wedge is Jarvis's memory + business context driving the browser.
6. **Trust strategy:** open-source the extension client; keep the agent driver proprietary.
7. **Permission UX parity:** the extension mirrors Muse's native permission settings language — "Ask for some actions" vs "Always ask," managed per website — instead of inventing new terminology. Users already trust that model.
8. **Auth via connector key:** the extension generates a secret key on the API-key model (shown once, never shared, revocable/regenerable). Users already understand API key value and leak consequences.
7. A private feature note has been filed with the Muse team (one-way, no reply expected).

---

## 1. Problem statement

Jarvis runs on a cloud VM. Its egress IP is a data-center IP, which triggers Cloudflare "verify you are human" challenges and bot blocks across a large share of the web — including sites critical to Pratik's work (automation, review, analysis tools outside the Meta ecosystem). Capability is not the limit; network identity is.

**What v1 must achieve:** let Jarvis perform browser tasks through the user's own Chrome — their IP, their logged-in sessions, with the user watching — under a permission model the user controls.

---

## 2. v1 scope

**In scope**
- Observe pages (DOM + accessibility tree + screenshots)
- Click, type, scroll, navigate (single-tab focus)
- Side-panel UI: status, consent cards, kill switch, pairing
- Permission tiers: **readonly / partial (copilot) / full (autopilot, session-scoped)**
- Per-site grants, action confirmations, audit log
- Pairing between the user's Chrome and Jarvis

**Out of scope (v1)**
- File downloads handling, multi-tab orchestration, mobile browsers
- Public launch, Chrome Web Store listing
- Automated prompt-injection classifier (v1 uses heuristics; classifier is v2)

---

## 3. System architecture

```
┌─────────────────────────────┐
│  USER'S CHROME (MV3 ext)    │
│  ┌───────────┐ ┌──────────┐ │
│  │Side panel │ │ Content  │ │
│  │UI         │ │ scripts  │ │
│  └───────────┘ └──────────┘ │
│  ┌────────────────────────┐ │
│  │ Background service     │ │
│  │ worker (wss session,   │ │
│  │ permission checks)     │ │
│  └────────────────────────┘ │
└──────────────┬──────────────┘
               │ wss (TLS), pairing-code auth
               ▼
┌──────────────────────────────┐
│  RELAY SERVER                │
│  v1: Jarvis VM (private)     │
│  beta: small VPS             │
│  passthrough only — no       │
│  page-content storage        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  JARVIS DRIVER (agent side)  │
│  observe → plan → propose →  │
│  [consent gate] → execute →  │
│  re-observe → repeat         │
│  + permission service        │
│  + audit log                 │
└──────────────────────────────┘
```

Three processes, one trust boundary: **nothing acts in the browser without passing the extension's local permission check**, even if the relay or driver is compromised.

---

## 4. Components

### 4.1 Extension (the hands) — Manifest V3

- **Side panel:** agent status, consent cards (Allow once / Always on this site / Deny), session tier indicator, kill switch (button + hotkey), pairing flow.
- **Content scripts:** build DOM + accessibility-tree snapshots, capture screenshots, perform clicks/types as trusted events.
- **Background service worker:** holds the WebSocket session, enforces permission checks locally before executing any action, maintains the audit log.
- **Install permissions:** `activeTab` + optional host permissions requested **on demand per site** — never `<all_urls>` at install. This is both a security posture and the trust story.
- **Distribution v1:** unpacked/self-hosted (private). **Open-sourced** at beta so anyone can audit what the client sends.

### 4.2 Relay (the wire)

- WebSocket Secure (wss) relay between extension and Jarvis.
- **Auth:** the extension generates a **connector secret key** (API-key model) on first run — displayed once in the side panel with an explicit never-share warning, the same gravity as revealing an API key. The user links it in Muse (chat or settings), the same motion as connecting any service. The key authenticates the wss session; it is revocable and regenerable at any time, and a compromised key dies in one tap. Session tokens derive from it and expire.
- **v1:** runs on Jarvis's VM (private use only). **Beta:** moves to a small dedicated VPS (Hostinger KVM 2 was the live candidate) so VM replacements never drop sessions.
- **Storage policy:** passthrough only. DOM snapshots and screenshots transit the relay and are never written to disk.

### 4.3 Jarvis driver (the brain)

- Runs on Jarvis's VM. Translates tasks into the browser-action protocol.
- **Consent gates** reuse the existing approval-card UX: proposed actions arrive in the side panel; nothing executes without the tier-appropriate approval.
- Maintains per-user memory of granted sites and tier preferences (memory, not the relay).

### 4.4 Permission service (the product)

User-facing language mirrors Muse's native **Settings > Permissions** model: **"Ask for some actions"** (default — acts within grants, T3 always confirms) vs **"Always ask"** (every action confirmed), managed per website exactly like the Websites list users already know. The tier table below is the engineering detail behind that language.

**Session tiers**
| Tier | Name | Behavior |
|------|------|----------|
| Readonly | Observer | See + summarize only. Zero actions. Default. |
| Partial | Copilot | Proposes each action; user approves per action or per site. Default for acting. |
| Full | Autopilot | Acts autonomously within an approved site list, **session-scoped** (expires when the session ends). T3 actions always confirm. |

**Action tiers (escalating friction)**
- **T0** — read/summarize: always allowed.
- **T1** — navigate, scroll, click within the current site: allowed in Copilot with per-action approval; allowed in Autopilot on approved sites.
- **T2** — type into fields, submit forms: Copilot approval required; Autopilot on approved sites.
- **T3** — cross-origin navigation, downloads, anything touching auth / payment / email / publishing / deletion: **always confirm, never auto-run, in every tier.**

**Site controls:** per-site allowlist/blocklist, grant expiry, one-tap revoke. Sensitive categories (banking, financial services) blocked by default in beta.

---

## 5. Safety & trust architecture

1. **Fresh Chrome profile (mandatory):** no saved passwords, no bank details, no sensitive data in the agent's reach. The user logs into only what they want automated — **login is consent**. **Critical:** never sign into Chrome with an existing Gmail to create this profile — Chrome Sync would import saved passwords, payment methods, bookmarks, and addresses from the Google account, directly violating this rule. Use a brand-new email or skip sign-in.
2. **Local enforcement:** the extension's service worker re-checks permissions before every action. A compromised relay cannot escalate.
3. **Instruction hierarchy:** page content is data, never instructions. The driver is prompted to treat on-page text as untrusted.
4. **v1 injection heuristics:** flag hidden text, instruction-like language in page content, and unexpected auth/payment flows → pause and ask the user. (Full classifier = v2.)
5. **Audit log:** every action with timestamp, site, action type, and screenshot reference. Local to the user, exportable. This is the accountability record.
6. **Kill switch:** prominent, always visible, instant session termination.
7. **Credential blindness (v2 target):** agent never sees passwords/OTPs — filled through a separate channel with per-task user authorization (the 1Password-for-agents pattern).

---

## 6. Protocol sketch (JSON, versioned)

- `pair.request` / `pair.confirm` — pairing-code handshake
- `observe.request` → `observe.result` (DOM/AX snapshot + screenshot)
- `act.propose` {tier, type, target, value} → `consent.grant` | `consent.deny` → `act.result`
- `session.abort` — kill switch, either direction
- `log.append` — audit entries

Protocol version negotiated at pairing; v1 = `1.0`.

---

## 7. Data & privacy

- Page content transits the relay; **nothing stored** (v1).
- Beta: opt-in diagnostics only (user explicitly enables; used for validation metrics).
- Audit log lives on the user's machine.
- No analytics SDKs in the extension, ever.

---

## 8. Build phases

**Phase 1 — v1 private (extension + relay + driver)**
readonly + copilot tiers, single-tab observe/act, pairing, side panel, audit log. Pratik-only testing.

**Phase 2 — hardening**
autopilot tier (session-scoped), T3 confirmations, injection heuristics, audit export, per-site management UI.

**Phase 3 — free beta (validation)**
20–50 users. Metrics defined **before** launch (see §9). Client open-sourced.

**Phase 4 — proposal package**
Metrics + architecture + security review → pilot/design partnership proposal to the Muse team. Commercials left open.

---

## 9. Beta validation metrics (define before launch)

- Task success rate (completed / attempted)
- Consent allow / deny / revoke rates per tier
- Abort/kill-switch rate
- Injection-heuristic triggers (true vs false positive, user-judged)
- Sites covered, sessions per user, 7-day retention
- Qualitative: trust score ("did you feel in control?"), support burden per user

These metrics are the proposal's evidence. No metrics, no proposal.

---

## 10. Risks & open questions

- **Prompt injection residual risk** — v1 heuristics are a speed bump, not a wall. Must be stated honestly in beta terms.
- **Relay ops** — VPS choice, uptime, and who pays during beta.
- **Chrome API churn** — MV3 APIs shift; pin versions, watch changelogs.
- **Support burden** — browser-control features generate high-touch support; beta must stay small.
- **Liability** — beta terms of service + fresh-profile rule are the mitigation; legal review before any public step.
- **Open:** pairing UX details; whether autopilot ships in beta or stays private-only.

---

*Debate log: 2026-10-10 — problem defined (data-center IP vs Cloudflare), option (b) selected, proxy alternative considered and set aside for the logged-in-session goal, build-vs-buy resolved as "build the bridge, not the agent," partnership reframed to pilot/design partnership.*
