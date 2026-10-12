# Security Policy

MuseBridge exists to make browser automation trustworthy. If you find a way to break that trust, we want to hear from you — privately, first.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting:** open this repo → **Security** tab → **Report a vulnerability**.

Please include:

- What you did, step by step, to reproduce it
- What you expected the consent/permission system to do, and what it actually did
- Which component is affected (extension, relay, or driver) and the version you tested
- Screenshots or logs, if they help (redact your own credentials)

We ask that you **do not open a public issue** for a security report, and that you give us a reasonable window to ship a fix before any public disclosure.

## What we care about most

This project is held to a higher bar in these areas — reports here get priority:

1. **Consent bypass** — any way to execute a browser action the user did not approve, approve an action for a site the user did not consent to, or obtain a broader permission tier than granted.
2. **Credential exposure** — passwords, session tokens, or other secrets leaving the user's machine through the relay, driver logs, snapshots, or audit trails.
3. **Session/permission spoofing** — a driver or page impersonating a site, forging a session grant, or replaying an old consent.
4. **Clickjacking / UI redress** — tricking the user into approving something they did not intend to approve.

## Out of scope

- Issues that require the attacker to already have code execution on the user's machine or full control of the user's Chrome profile — those defeat any extension-level control.
- The user's own credentials stored in their Chrome profile — the [fresh-profile rule](README.md#%EF%B8%8F-safety-first) exists precisely because the extension cannot protect what the profile itself exposes.
- Social-engineering the user into clicking "Allow" — the consent UX is designed to make approval deliberate, but no UI can stop a user from consenting on purpose.

## Known limitations (disclosed, not vulnerabilities)

- The relay terminates TLS, so it could technically observe traffic in transit. It stores nothing and interprets nothing; end-to-end encrypted payloads are the planned v2 answer. See [TRANSPORT.md](TRANSPORT.md).

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest release (see [releases](https://github.com/polesymbol/jarvis-browser-bridge/releases)) | ✅ |
| Older releases | ❌ — please upgrade and re-test before reporting |

## Past audits

This codebase has been through internal adversarial audits (rounds documented in commit history, e.g. v0.2.2 and v0.2.5). We welcome independent ones.
