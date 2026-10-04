# Changelog

## 0.5.0 — 2026-10-04
- **An agent created in Paperclip gets its Hermes profile automatically.** With a shared workspace declared in `~/.config/hermes-control/workspace` (written by `hermes-paperclip-pack init`), a Hermes agent with no matching profile is prepared on `agent.created` / `agent.updated` and when the Hermes page is opened: `hermes profile create <slug> --no-alias --clone --description "<Name> — <title>"` in the company instance, `<ws>/agents/<slug>/{fiche.md, rapports/, memoire/{MEMORY.md,USER.md}, medias/{brouillons,valides,publies}/}`, `memories` → `agents/<slug>/memoire` (existing Hermes memory files are moved, never lost), `journal` → the profile's `logs/`, common skills of `<ws>/hermes/skills` linked, `SOUL.md` from `<ws>/modeles/`. Idempotent, never deletes. The 5-minute job (no company scope) never creates anything.
- **Page**: a « Dossiers communs » card (workspace paths), a **« Préparer l'agent »** button for agents without profile (action `prepare-agent`, board users only), and a **Telegram** column per profile: the bot token is written to `<profile>/.env` (mode 600) and `hermes gateway install --start-now` is run for that profile; the token is never read back, shown or stored in plugin state (action `set-telegram`, only for known profile paths). New capability `ui.action.register` (Paperclip refuses an in-place upgrade on new capabilities: uninstall / reinstall the plugin).
- **Adapter**: when the agent has no working directory in Paperclip, `cwd` defaults to `<ws>/agents/<slug>` if it exists.
- Known limit: Hermes installs one gateway service per user (`hermes-gateway.service`); several Telegram agents on one machine need `hermes gateway run` per profile (phase 2).
- 44 tests.

## 0.4.0 — 2026-10-04
- **Skills follow the agent into its Hermes profile.** The built-in Hermes adapter links Paperclip-managed skills into `~/.hermes/skills` (it resolves `$HOME`, never `HERMES_HOME`), but Hermes only loads `$HERMES_HOME/skills`. Since Hermes Control runs each agent on its own profile, the skills were invisible there (seen on CDjam: Chef could not find `first-task`). The adapter now links every skill assigned in Paperclip into `<profile>/skills/<name>` — on skill sync (the Skills tab) and at the start of every run — and removes the link when a skill is unassigned. Only links that point to a Paperclip source are ever removed; skills you placed in the profile yourself are left alone and listed read-only in the Skills tab.
- New shared map `~/.config/hermes-control/agents.json` (agent id → instance/profile/home), written by the adapter at run time and by the plugin at every sync, because Paperclip's `listSkills` / `syncSkills` hooks only carry the agent id.
- `listSkills` / `syncSkills` overrides: the Skills tab shows the real link path in the profile, and a warning when the agent's profile is not known yet.
- Nothing removed: Provider/Model menus, name → profile, provider/model/thinking sync and the instances view are unchanged. 48 tests.

## 0.3.0 — 2026-10-03
- **Rethought after feedback**: no more choice pages. Paperclip's own agent form is the control surface.
- New **adapter** (`adapter/`): overrides the built-in `hermes_local`; Provider/Model menus list Hermes providers and models; the agent name picks its Hermes profile at run time (`HERMES_HOME`).
- Plugin reduced to one read-only **instances** view + a Paperclip → Hermes sync of provider / model / thinking into the matched profile's `config.yaml`.
- Removed: agents / sessions / errors / commands tabs, settings page, widget, actions, generated launchers.

## 0.2.0 — 2026-10-03
- **Agents tab**: choose instance / profile / model / provider per agent and apply (generated launcher + adapter config), plus a « + New Hermes agent » hire form.
- **Commands tab**: `auth status`, `doctor`, set profile model, set profile description, create profile, restart dashboard — all from Paperclip, executed without a shell.
- Discovery of instances from a root folder (`instancesRoot`) and `~/.hermes`, even without agents.
- Removed the agent detail tab (never rendered by Paperclip 2026.1001).

## 0.1.0 — 2026-10-03
First working version, tested on a Paperclip 2026.1001.0 instance with 3 Hermes instances / 5 profiles.
- Discovery of Hermes instances from each agent's `hermesCommand` launcher (`<launcher> config path`).
- Page (instances · sessions · errors), agent detail tab with Paperclip ↔ Hermes model drift and one-click sync, sidebar entry, dashboard widget, settings page.
- Read-only readers: `config.yaml`, `profile.yaml`, `profiles/*`, `state.db` (node:sqlite), `logs/errors.log`, `hermes auth status`.
- Health job every 5 minutes (works without company scope), events `auth.expired` / `errors`.
- Dashboard links from settings or auto-detected systemd user units.
