# Transport: reaching the relay from both sides

Status: design verified 2026-10-11. No code changes needed — relay, extension,
and driver already support everything below.

## Problem
Pratik's relay runs on his PC (`ws://127.0.0.1:8787`). His local driver reaches
it, but Jarvis's VM cannot:
- Cloudflare quick tunnels fail from the VM (TLS registration handshake dies;
  `cloudflared` ignores the egress proxy).
- Pratik's tunnel URLs return Cloudflare 403 ("request was blocked") to the
  VM's datacenter IP.

## Verified fact (2026-10-11)
Outbound `wss://` WebSocket connections from the VM **work** through the
egress proxy (CONNECT tunneling; tested live against a public echo server —
full handshake + round-trip). So the VM can dial out to any public relay.

## Design: public relay, both sides dial out
Run the existing relay on a small public host with TLS. Both clients connect
outbound — no inbound holes, no tunnels from the VM side.

| Piece | What changes |
|---|---|
| Relay | Run `server.js` on the host with `TLS_CERT`/`TLS_KEY` set (Let's Encrypt). Already supported — no code change. |
| Extension | Panel → Relay URL becomes `wss://<host>:8787` → Connect. No code change. |
| Driver (VM) | `node driver/driver.js --relay wss://<host>:8787 --key <key> …`. Already proxy-aware (skips proxy for loopback). No code change. |
| Auth | Unchanged: connector key pairs extension + driver into a private room. |

## Hosting options
1. **Pratik's own VPS/hosting** (runs Node) — he operates the relay himself.
   Most private. ~$4–6/mo for a tiny VPS, or free on existing hosting.
2. **ngrok (or similar) from his PC** — relay stays on his PC; VM dials the
   public ngrok URL. No VPS. Free tier URL rotates; PC must stay on.
3. **Free-tier cloud host** (Fly.io / Render / Railway) — zero cost, third
   party operates the relay.

## Honest security note
TLS terminates at the relay, so the relay operator *can* observe traffic in
transit (the relay stores nothing — by design — but observation is possible).
Mitigations: options 1–2 keep the operator as Pratik himself. v2 hardening:
end-to-end encrypt the observe/propose/result payloads with a key known only
to the extension and the driver, so even the relay operator sees ciphertext.
