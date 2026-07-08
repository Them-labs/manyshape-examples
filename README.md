# manyshape-examples

An example app on [Manyshape](https://github.com/Them-labs): one app (Mail) shipped as a **capability contract**, a **runtime** that hosts AI-generated interfaces in a capability sandbox, and an **embedded agent** that compiles a personal surface from your intent. Surfaces can be **vanilla or React** (`framework: react` in the header; JSX is transpiled server-side, the runtime injects a ~25KB Preact-compat bundle into the same sandbox).

## Run

Requires **MongoDB** locally (`brew services start mongodb-community`, or set `MONGODB_URI`). Threads live in db `manyshape-mail`. `RESEED=1 npm start` resets the demo mailboxes.

> Uses the `@manyshape/*` packages ([sdk](https://github.com/Them-labs/manyshape-sdk), [surface-sdk](https://github.com/Them-labs/manyshape-surface-sdk), [chat-sdk](https://github.com/Them-labs/manyshape-chat-sdk), [agent](https://github.com/Them-labs/manyshape-agent)). These aren't on npm yet - until they are, clone the sibling `@manyshape` repos alongside this one and link them locally (`npm link`).

```sh
npm install
cp .env.example .env      # then paste your GEMINI_API_KEY (or ANTHROPIC_API_KEY) into .env
npm start                 # without a key: fallback mode, canned surfaces matched by keyword
open http://localhost:8484              # standalone runtime
open http://localhost:8484/vendor.html  # the vendor's own app, with the embedded chat SDK
```

The agent uses Gemini (`gemini-2.5-pro`, override with `GEMINI_MODEL`) when `GEMINI_API_KEY` is set, otherwise Claude (`claude-opus-4-8`) when Anthropic credentials exist, otherwise canned fallbacks.

Try it: as **jk**, type *"I live in my inbox - make it a task board. Archiving a thread completes it."* Switch to **maya** and type *"Show my mail as an events calendar grouped by day."* Same app, same contract - two different products. Surfaces and intent specs persist per user; **Reset to reference** reverts.

## What's real in this example

| Concept | Implementation here |
|---|---|
| Authority plane | `server.js` - mail data mounted via `@manyshape/sdk`'s `createAuthorityRouter`; authz, validation, and call-time policies server-side |
| Capability contract | `contract/mail.contract.json` - schemas, 5 capabilities with `risk`/`gesture` annotations, policies, conformance spec, design tokens |
| Reference surface as source | `contract/reference-surface.html` - shipped to the agent as remix substrate |
| Surface sandbox | srcdoc iframe, `sandbox="allow-scripts"` + CSP `default-src 'none'` - no network, no storage; the injected guest SDK postMessage bridge is the only I/O |
| Capability bridge | `runtime/runtime.js` - refuses calls outside declared caps ∩ contract caps |
| Activation gate | header parse → caps ⊆ contract → static policy scan → conformance (boots + first cap call in 8s, zero JS errors). Failure keeps the old surface live |
| Call-time policy | `mail.send` is `gesture: true` - the authority plane rejects it without a fresh user gesture |
| React + vanilla | Agent picks `framework:` per surface; JSX transpiled with esbuild before the gate |
