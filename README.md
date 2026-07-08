# Manyshape - MVP

A working slice of the [architecture](../ARCHITECTURE.md): one app (Mail) shipped as a **capability contract**, a **runtime** that hosts agent-generated interfaces in a capability sandbox, and an **embedded agent** that compiles a personal surface from your intent. Surfaces can be **vanilla or React** (`framework: react` in the header; JSX is transpiled server-side, the runtime injects a ~25KB Preact-compat bundle into the same sandbox). Ask for React in your intent to see it.

## Run

Requires **MongoDB** running locally (`brew services start mongodb-community`, or set `MONGODB_URI`). Threads live in db `manyshape-mail`, the platform's users/sessions/registry/experiences in `manyshape-platform`. `RESEED=1 npm start` resets the demo mailboxes.

```sh
cd mvp
npm install
cp .env.example .env      # then paste your GEMINI_API_KEY (or ANTHROPIC_API_KEY) into .env
npm start                 # without a key: fallback mode, canned surfaces matched by keyword
open http://localhost:8484              # standalone runtime
open http://localhost:8484/vendor.html  # the vendor's own app, with the embedded chat SDK
node ../platform/server.js              # optional: platform on :8600 - accounts, registry, cloud experiences
```

With the platform running, create an account at http://localhost:8600 (email + password; sessions last 30 days, revocable per device from the dashboard) and sign in from any doorway - your experiences sync across the runtime, the [chat SDK](../packages/chat-sdk/), and the [browser extension](../extension/). Logged out, the runtime still works locally.

The agent uses Gemini (`gemini-2.5-pro`, override with `GEMINI_MODEL`) when `GEMINI_API_KEY` is set, otherwise Claude (`claude-opus-4-8`) when Anthropic credentials exist, otherwise canned fallbacks.

Try it: as **jk**, type *"I live in my inbox - make it a task board. Archiving a thread completes it."* Switch to **maya** and type *"Show my mail as an events calendar grouped by day."* Same app, same contract - two different products. Surfaces and intent specs persist per user (localStorage); **Reset to reference** reverts.

## What's real in this demo

| Architecture concept | Implementation here |
|---|---|
| Authority plane | [server.js](server.js) - in-memory mail data mounted via [`@manyshape/sdk`](../packages/sdk/)'s `createAuthorityRouter`; authz, validation, and call-time policies server-side |
| Capability contract | [contract/mail.contract.json](contract/mail.contract.json) - schemas, 5 capabilities with `risk`/`gesture` annotations, policies, conformance spec, design tokens |
| Reference surface as source | [contract/reference-surface.html](contract/reference-surface.html) - shipped to the agent as remix substrate |
| Surface sandbox | srcdoc iframe, `sandbox="allow-scripts"` (no same-origin) + CSP `default-src 'none'` - no network, no storage; the injected [guest SDK](../packages/surface-sdk/guest-sdk.js) postMessage bridge is the only I/O |
| Capability bridge | [runtime.js](runtime/runtime.js) - refuses calls outside declared caps ∩ contract caps |
| Activation gate | header parse → caps ⊆ contract → static policy scan (fetch/XHR/WebSocket/external URLs rejected) → conformance (boots + first successful cap call in 8s, zero JS errors). Failure keeps the old surface live - never a broken screen |
| Call-time policy | `mail.send` is `gesture: true` - the authority plane rejects it without a fresh user gesture (`curl` it to see the 403) |
| Intent spec | The durable artifact: each utterance is recorded; the agent always recompiles from the *full* spec, so customizations survive regeneration |
| The agent | `POST /api/agent` - Gemini or Claude (see Run), prompted with contract + reference source + intent spec; returns a complete surface file |
| React + vanilla | Agent picks `framework:` per surface; JSX transpiled with esbuild before the gate; [react-entry.js](../packages/surface-sdk/react-entry.js) exposes `window.React`/`ReactDOM` (Preact compat) + a `useCap` hook inside the sandbox |
| Audit log | Every activation, rejection, and fallback with reasons |

## Known v0 shortcuts

- `gestureAge` on capability calls is self-reported by the (untrusted) guest - real enforcement needs a trusted-event scheme.
- The static policy scan is string/regex-based (defense-in-depth: CSP + sandbox are the real wall).
- Workflows (user-authored middleware), contract versioning/migration, and the registry are not in this slice - see the 12-week plan in the [main README](../README.md).
