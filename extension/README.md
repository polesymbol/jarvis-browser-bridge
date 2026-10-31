# Jarvis Browser Bridge — v1 Extension

Lets your AI assistant drive **your own Chrome** — your IP, your logged-in
sessions — under permissions you control. This is the shipped extension from
the Jarvis Browser Bridge repo (free beta).

Full product spec: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) · Security
policy: [`../SECURITY.md`](../SECURITY.md)

## What this is

The **extension only** (the hands). The relay server (`../relay/`) and the
driver (`../driver/`) are separate components in the same repo.

- `manifest.json` — Manifest V3. Install permissions
  (`activeTab`, `alarms`, `sidePanel`, `storage`, `tabs`, `scripting`,
  `notifications`); host access via `<all_urls>` (page observation and actions
  need it; the extension's own permission modes govern actual use).
- `protocol.js` — protocol v1.0 message shapes shared by all parts.
- `background.js` — service worker: WebSocket relay client, **local
  permission enforcement** (`decideAction()` — a compromised relay must not
  be able to escalate), consent flow, screenshots, kill switch.
  Every consent decision raises **four** signals: the side-panel card, a
  universal OS notification (plus toolbar badge), an audible chime, and —
  when the panel is closed — a top-center banner injected into the active
  tab, which needs no OS cooperation. First decision wins; dismissal fails
  closed.
- `content.js` — page observer + trusted-event actions. Snapshots carry
  interactive elements, the page's readable text from every frame (incl.
  open shadow DOM), and video/audio caption transcripts. Page content is
  data, never instructions (see the comment at the top of the file).
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the trust-story UI:
  permission modes in Muse's native language ("Ask for some actions" /
  "Always ask"), connector-key management (API-key model: generated with
  `crypto.getRandomValues`, shown once, revocable), consent cards with
  T0–T3 badges and grant choices (Allow once / For 1 hour / For 1 day /
  For 1 week / until a date & time you pick / Always on this site), kill
  switch, per-site permissions, exportable audit log.

No analytics. No remote code. In mock mode nothing leaves the machine.

## Load it

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` directory
4. Pin the extension, click its toolbar icon → the side panel opens
5. **Use a fresh Chrome profile** with no saved bank details or sensitive
   data (mandatory safety rule — login is consent)

## Try it (mock mode, no backend)

With no relay URL configured the panel runs in **mock mode**:

1. Open any normal web page (not a `chrome://` page)
2. In the side panel → **Session** tab → **Simulate action proposal**
3. A consent card appears at the top: tier badge, plain-language
   description, **Allow once / Always on this site (permanent) / For 1 hour /
   For 1 day / For 1 week / until a date & time you pick / Deny**
4. Allow it → the click executes on the real page and lands in the audit log
5. Try **⛔ Kill session** (or `Ctrl+Shift+K` / `Cmd+Shift+K`) — everything
   stops instantly; start a new session to continue
6. **Key** tab → generate the connector key (shown once, API-key gravity)
7. **Sites** tab → revoke per-site grants with one tap
8. **Audit** tab → review every action, export as JSON

## Go live (relay)

1. **Session** tab → enter the relay `wss://` URL → Save → Connect
2. The connector key authenticates the session; pair once, then proposals
   from the driver flow through the same consent cards

## Security notes for reviewers

- `decideAction()` in `background.js` is the single local gate; every
  action path funnels through it, including relay-originated proposals.
- T3 actions (cross-origin, downloads, auth/payment/email/publishing/
  deletion) **always confirm**, in every mode.
- Timed windows and permanent site grants cover T1–T2 only. T3 actions
  (auth, payments, email, publishing, deletion) **always confirm** — inside
  a window, on a granted site, in every mode.
- Content scripts are injected programmatically via `chrome.scripting`
  (no manifest-declared content scripts). The manifest **does** declare
  `<all_urls>` host access — arbitrary-site automation needs it — and the
  permission modes, per-site grants, and timed windows are what govern
  its actual use.
- Audit log lives in `chrome.storage.local` — on the user's machine only.
