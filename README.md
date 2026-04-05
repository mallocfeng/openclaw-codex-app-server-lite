# OpenClaw Codex App Server Lite

Minimal Telegram-focused OpenClaw plugin for:

- browsing Codex projects
- browsing existing Codex threads
- binding a Telegram conversation to an existing thread
- creating a new thread inside a selected project and binding to it

## Commands

- `/codex_start`
- `/codex_stop`

## Install

```bash
openclaw plugins install --dangerously-force-unsafe-install @mallocfeng/openclaw-codex-app-server-lite
openclaw gateway restart
```

## Uninstall

```bash
openclaw plugins uninstall @mallocfeng/openclaw-codex-app-server-lite
openclaw gateway restart
```

## Notes

- After install, restart the OpenClaw gateway before testing commands in Telegram.
- After uninstall, restart the OpenClaw gateway so the command registry and plugin state are refreshed.
