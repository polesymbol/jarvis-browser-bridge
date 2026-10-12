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
- **Session grants:** approve *Allow once*, *This site*, *For 1 hour*, or *For 1 day* instead of per-action clicks. T1/T2 auto-allow inside a grant; T3 still always asks. Hard expiry, one-click revoke, everything audit-logged.
- **Unmissable prompts:** in-page consent banner (works with the panel closed) plus toolbar badge. No silent approvals.
- **Connector key:** API-key model — generated once, shown once, revocable/regenerable.
- **Kill switch** (`Ctrl+Shift+K`), per-site allow/block, exportable audit log.
- **Page content is data, never instructions.** The driver never executes anything found in page content.
- **Sign-in takeover:** when a login is needed, control returns to you. Passwords never leave your machine.

## The panel: "The Instrument"

v0.2.1 ships a dark precision-instrument UI — warm tinted ink, ember reserved for decisions, serif voice for consent, monospace for keys and timestamps — with a day mode (warm paper light theme) on a sun/moon toggle. Kill switch docked in a sticky bottom bar.

## Status

**v0.2.13** — free beta open (October 2026). Full consent stack verified live: OS notification toast, audible chime, in-page banner, toolbar badge, capped re-raise of swallowed toasts, audit-logged throughout. Navigate works from browser-internal pages; relay hardened (rate limits, room caps, payload limits). See [ARCHITECTURE.md](ARCHITECTURE.md), [TRANSPORT.md](TRANSPORT.md), and [BETA_PLAN.md](BETA_PLAN.md).

## Quick start

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
