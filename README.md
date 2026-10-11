# Jarvis Browser Bridge

Your AI assistant drives **your own Chrome** — your IP, your logged-in sessions — under permissions you control. Not a competing browser. An extension of the assistant to the rest of the web, with explicit per-site consent.

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

**v0.2.1** — private v1, end-to-end tested October 2026 (observe → consent → approved action → result, all through the public relay). Now in beta preparation. See [ARCHITECTURE.md](ARCHITECTURE.md) and [TRANSPORT.md](TRANSPORT.md).

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
