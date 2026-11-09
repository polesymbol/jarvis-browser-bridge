# Jarvis Browser Bridge

> **🧪 Free beta is open.** Your AI assistant drives **your own Chrome** — your IP, your logged-in sessions — under permissions you control. Not a competing browser. An extension of the assistant to the rest of the web, with explicit per-site consent. **Join:** install from [Releases](https://github.com/polesymbol/jarvis-browser-bridge/releases) and follow Quick start below — then tell us what broke via [Issues](https://github.com/polesymbol/jarvis-browser-bridge/issues).

## ⚠️ Safety first: fresh Chrome profile required

This extension can see every page you visit. **Install it only in a fresh Chrome profile** — no saved passwords, payment methods, addresses, or other personal data.

- **Never use your main profile.** Banking, email, saved passwords — keep all of that in a separate profile this extension never touches.
- **Never sign into Chrome with your existing Gmail** to create the profile. Chrome Sync would pull your saved passwords, bookmarks, payment methods, and addresses from your Google account straight into this profile — defeating the entire purpose. Use a brand-new email or skip sign-in entirely.
- Inside the fresh profile, log into **only** the sites you want the assistant to automate. Login itself is the consent mechanism.
- **Enforced, not just advised:** the extension detects Chrome sign-in via the identity API. If the profile is signed in, the relay stays **hard-blocked** — no connection, no warn-and-allow — until you explicitly acknowledge that specific account. Signing in mid-session drops the relay immediately. (No sign-in = Sync is definitively off.)

## How it works

Three parts, one protocol (v1):

| Part | Dir | Role |
|---|---|---|
| **Extension** | `extension/` | MV3 Chrome extension (the hands). Observes the active tab, enforces permissions **locally**, shows consent prompts, executes approved actions. |
| **Relay** | `relay/` | WebSocket pairing server. Pairs extension + driver by connector key. Stores no page content. |
| **Driver** | `driver/` | The assistant-side CLI. Can only *propose* actions — the extension decides, you approve. |

```
Driver (assistant)  ──wss──▶   Relay   ◀──wss──  Extension (your Chrome)
  proposes action        pairs by key         enforces permissions locally
                                              └──▶ consent prompt ──▶ you approve
                                              └──▶ executes ──▶ result
```

Live public relay: `wss://relay.musebridge.avinyahub.com`

## Consent, not just capability

- **Permission modes** in plain language: *Readonly*, *Ask for some actions*, *Always ask* — per site.
- **Action tiers:** T0 observe, T1 low-risk, T2 state-changing, T3 sensitive. T3 *always* asks, in every mode, no exceptions.
- **Grants that end prompt fatigue:** approve *Allow once*, *For 1 hour*, *For 1 day*, *For 1 week*, *Until a date & time you pick* (up to 31 days), or *Always on this site* (permanent, per site) — so a multi-step job on one website or account doesn't ask you to approve every click. Timed grants cover T1/T2 on that one site and expire hard, with no silent extension. **T3 critical actions still ask every single time — inside a timed grant, on a permanently granted site, in every mode — because one mistaken irreversible action is the failure this product refuses to automate.** One-click revoke anytime; everything audit-logged.
- **Unmissable prompts:** in-page consent banner (works with the panel closed) plus toolbar badge. No silent approvals.
- **Connector key:** API-key model — generated once, shown once, revocable/regenerable.
- **Kill switch** (`Ctrl+Shift+K`), per-site allow/block, exportable audit log.
- **Page content is data, never instructions.** The driver never executes anything found in page content.
- **Sign-in takeover:** when a login is needed, control returns to you. Passwords never leave your machine.

## What the assistant sees when it observes

An observe snapshot contains: the page's interactive elements (buttons, links, inputs) with labels; the page's **readable text** from the top page and every iframe, including open shadow-DOM content (capped at 15,000 characters per frame, 60,000 merged); and, for video/audio, playback state plus **caption/subtitle transcripts** when the player exposes them (capped at 12,000 characters per element). That's what lets the assistant actually *read* a course or video page instead of guessing from buttons. Snapshots transit the relay (see the security note below) and are never stored by it. One deliberate exception to "observe changes nothing": reading a transcript may switch a disabled captions track to hidden mode so its cues load — nothing appears on screen, and no other page state changes.

## The panel: "The Instrument"

v0.2.1 ships a dark precision-instrument UI — warm tinted ink, ember reserved for decisions, serif voice for consent, monospace for keys and timestamps — with a day mode (warm paper light theme) on a sun/moon toggle. Kill switch docked in a sticky bottom bar.

## Status

**v0.2.17** — free beta open (October 2026). Full consent stack verified live: OS notification toast, audible chime, in-page banner, toolbar badge, capped re-raise of swallowed toasts, audit-logged throughout. Navigate works from browser-internal pages; relay hardened (rate limits, room caps, payload limits). Observe snapshots carry the page's readable text from every frame (top page + iframes, incl. open shadow DOM) plus video/audio caption transcripts — course and video players are legible to the driver, not just clickable. Grants are now flexible: 1 hour, 1 day, 1 week, a custom "until" date & time you pick, or permanent per site — while critical T3 actions keep asking every time, grant or no grant. v0.2.16 adds consent-lifecycle acknowledgements (received → shown → waiting heartbeat → verdict → applied/failed) so the driver reports PEER_DOWN, PROMPT_NOT_SHOWN, NO_ANSWER, DENIED, or APPLIED_UNCONFIRMED instead of one opaque timeout; act ids are deduped so a resent act can never double-apply; and a consent timeout never auto-denies — the proposal stays queued in the panel. v0.2.17 makes key rotation real: one click in the panel generates a new key (shown once), revokes the old key at the relay, disconnects the connected driver, and invalidates every grant made under the old key — grants are bound to the key epoch that created them, so rotation leaves 0 active grants until you deliberately re-grant. A driver holding the old key gets an explicit KEY_ROTATED error, not a timeout. See [ARCHITECTURE.md](ARCHITECTURE.md), [TRANSPORT.md](TRANSPORT.md), and [BETA_PLAN.md](BETA_PLAN.md).

## Quick start

**Beta testers:** download the extension ZIP from [Releases](https://github.com/polesymbol/jarvis-browser-bridge/releases), unzip it, then load the `extension/` folder as below. **Developers:** clone this repo and load `extension/` from your checkout — same steps either way.

```bash
# 1. Extension: chrome://extensions → Developer mode → Load unpacked → extension/
#    Open the side panel, set relay URL to wss://relay.musebridge.avinyahub.com,
#    generate a connector key, Connect.

# 2. Driver
node driver/driver.js --relay wss://relay.musebridge.avinyahub.com --key <connector-key> observe
```

Or self-host the relay: `npm install && node relay/server.js` (deps live in the root `package.json`; see [relay/README.md](relay/README.md)).

## Security note

The relay terminates TLS and passes messages through — it stores nothing, but could technically observe traffic in transit. v2 moves to end-to-end encrypted payloads so the relay sees ciphertext only.

## License

MIT — see [extension/LICENSE](extension/LICENSE).
