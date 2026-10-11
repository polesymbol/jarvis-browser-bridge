# Jarvis Browser Bridge

Lets your AI assistant drive **your own Chrome** — your IP, your logged-in sessions — under permissions you control.

The idea: AI assistants are fenced inside their own apps. Everything you do in a browser — on products outside any single platform — is out of reach. This bridge extends an assistant into the user's own browser with **explicit, per-site, user-controlled consent**. Not an alternative browser. An extension of the assistant to the rest of the web. No tech giant offers user-consented automation of third-party products today.

## How it works

Three parts, one protocol (v1):

| Part | Dir | Role |
|---|---|---|
| **Extension** | `extension/` | MV3 Chrome extension (the hands). Observes the active tab, enforces permissions **locally**, shows consent cards, executes approved actions. |
| **Relay** | `relay/` | WebSocket pairing server. Connects the extension and the driver with a connector key. Stores no page content. |
| **Driver** | `driver/` | The assistant-side CLI. Can only *propose* actions — the extension decides, the user approves. |

```
Driver (assistant)  ──wss──▶   Relay   ◀──wss──  Extension (your Chrome)
  proposes action        pairs by key         enforces permissions locally
                                              └──▶ consent card ──▶ you approve
                                              └──▶ executes ──▶ result
```

## Security model

- **Local enforcement.** The permission gate (`decideAction()`) runs in the extension's service worker. A compromised relay cannot escalate privileges, skip consent, or act on blocked sites.
- **Permission modes** in the user's own language: *Readonly*, *Ask for some actions*, *Always ask*.
- **Action tiers:** T0 observe, T1 low-risk, T2 state-changing, T3 sensitive — T3 *always* asks, in every mode, no exceptions.
- **Connector key:** API-key model — generated once, shown once, revocable/regenerable.
- **Kill switch** (`Ctrl+Shift+K`), per-site allow/block, exportable audit log.
- **Page content is data, never instructions.** The driver never executes anything found in page content.

## Status

Private v1. End-to-end tested October 2026: observe returned a full DOM snapshot, a proposed click raised the consent card, the user approved, the click executed. See [ARCHITECTURE.md](ARCHITECTURE.md) and [TRANSPORT.md](TRANSPORT.md).

## Quick start (private test)

```bash
# 1. Relay (any machine reachable by both sides, or local for testing)
cd relay && npm install && node server.js

# 2. Extension: chrome://extensions → Developer mode → Load unpacked → extension/
#    Open the side panel, set the relay URL, generate a connector key, Connect.

# 3. Driver
node driver/driver.js --relay ws://127.0.0.1:8787 --key <connector-key> observe
```

## License

MIT — see [extension/LICENSE](extension/LICENSE).
