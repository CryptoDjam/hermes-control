# Changelog

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
