# OpenClaw Codex App Server Lite

Minimal OpenClaw plugin for Telegram-first Codex thread binding and message relay.

This plugin lets a Telegram conversation bind to a local Codex thread, then continue sending normal messages into that thread through `codex app-server`.

## Install

From npm:

```bash
openclaw plugins install --dangerously-force-unsafe-install @mallocfeng/openclaw-codex-app-server-lite
```

From a local checkout:

```bash
openclaw plugins install --link "/absolute/path/to/openclaw-codex-app-server-lite"
```

## Commands

- `/codex_start`: list threads, create a thread, or bind the current Telegram conversation
- `/codex_stop`: detach the current Telegram conversation from the bound Codex thread

## Config

- `command`: Codex CLI command to run, defaults to `codex`
- `args`: extra args passed to `codex app-server`
- `defaultWorkspaceDir`: default workspace used when creating or resuming threads
- `defaultModel`: preferred model for new threads
- `inheritHostAuthEnv`: when `true`, forward host auth env vars like `OPENAI_API_KEY` into `codex app-server`

`inheritHostAuthEnv` defaults to `false`. That is intentional. On machines where OpenClaw uses provider env vars like `OPENAI_API_KEY=ollama`, forwarding the host auth env into Codex can override Codex OAuth login and break normal thread replies.

## Latest Update

Version `0.0.1` includes the auth-environment fix for post-bind message failures.

- Stop forwarding host provider auth env vars such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OLLAMA_API_KEY` into `codex app-server` by default.
- Preserve a manual escape hatch with `inheritHostAuthEnv=true` for setups that intentionally use env-based auth.
- Improve turn failure messaging so Codex auth conflicts are reported clearly instead of surfacing the raw upstream 401 error.

## Release

Publish a new npm version with:

```bash
npm version patch
npm publish --access public
```
