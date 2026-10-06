# Hermes Control — Hermes Agent as the engine, Paperclip in charge

Source: https://github.com/CryptoDjam/hermes-control · Author: Cyril M · MIT

Run your [Paperclip](https://github.com/paperclipai/paperclip) agents on [Hermes Agent](https://github.com/NousResearch/hermes-agent) **without leaving Paperclip's own agent form**. Two small pieces, one project:

## 1. The adapter (`adapter/`) — Hermes's lists in Paperclip's menus
A drop-in **override of the built-in `hermes_local` adapter** (an official Paperclip feature: external adapters may override built-in types, with pause/resume). Everything is the official Hermes adapter, except:
- **Provider** menu (Agent → Harness / Runtime) lists the providers actually configured in your Hermes instances;
- **Model** menu lists the models Hermes knows for them (`provider_models_cache.json`);
- default model/provider (`detectModel`) come from Hermes;
- at run time, **the agent runs only in the Hermes profile explicitly assigned to it** (0.6): the adapter reads `~/.config/hermes-control/agents.json` (agent id → instance / profile / home), written by the plugin when it syncs or prepares the agent. `HERMES_HOME` is set to that profile; no launcher scripts needed. **An agent with no assignment refuses to run** with the message « agent non affecté à une instance Hermes : synchronise ou prépare l'agent dans Paperclip (page Hermes) »; so does an assignment whose profile has lost its `config.yaml`. To assign an agent: install the plugin, open the Hermes page (agents whose name matches an existing profile — same name, or a description starting with the name — are linked and recorded), or click « Préparer l'agent » for an agent without profile (or simply create / edit it in Paperclip: `agent.created` / `agent.updated` prepare it).
- **Test environment** shows the instances found;
- **skills assigned in Paperclip follow the agent**: the built-in adapter links Paperclip-managed skills into `~/.hermes/skills` (it looks at `$HOME`, not `HERMES_HOME`), but Hermes only loads `$HERMES_HOME/skills`. Hermes Control links each assigned skill into `<profile>/skills/<name>` when you sync skills in Paperclip and at the start of every run, and removes the link when you unassign it (only links pointing to a Paperclip source are removed; your own skills in the profile are left alone and listed read-only). Because Paperclip's skill hooks only carry the agent id, the agent → profile map lives in `~/.config/hermes-control/agents.json` (written at run time and by the plugin's sync).

Install (local path or npm):
```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Where instances are: `~/.hermes`, plus the folders listed in `~/.config/hermes-control/roots` (one per line: an instance, or a folder of instances), plus `$HERMES_CONTROL_ROOTS`. Hermes binary: `$HERMES_CONTROL_HERMES_BIN` if set, else `~/.local/bin/hermes`, else `hermes` in Paperclip's PATH. Roll back any time: `paperclipai adapter override hermes_local` (pause) or `adapter delete hermes_local`.

## 2. The plugin — Paperclip → Hermes sync, one view
Paperclip is the master. For every Hermes agent, the plugin reads **name, working directory, provider, model, thinking** from Paperclip, finds the Hermes profile by name, records the assignment in `agents.json`, and writes **provider / model / thinking** into that profile's `config.yaml` (`hermes config set`, no shell, only when different; never when the `config.yaml` is unreadable). It runs on `agent.updated` / `agent.created`, when the view is opened, and every 5 minutes.

The only UI: a sidebar link **Hermes** → the **instances** view (instance · profile · state · agent · provider/model sent · working directory · auth status · last sync · health alerts). No settings page. The view has exactly two actions: **« Préparer l'agent »** (prepare the Hermes profile of an agent that has none) and a **Telegram** token field per profile. Since 0.6, opening the view **has no side effects**: it reads files, syncs already-linked agents, and never prepares anything nor runs any launcher.

```
paperclipai plugin install paperclip-plugin-hermes-control
```

## 3. With `hermes-paperclip-pack`: agents prepare themselves (0.5, hardened in 0.6)
When a shared workspace is declared in `~/.config/hermes-control/workspace` (one line, written by `hermes-paperclip-pack init` — the companion pack, private for now, publication planned), a Hermes agent created in Paperclip with no matching profile is **prepared automatically** on `agent.created` / `agent.updated`: profile cloned from the **company's own instance** (the one named after the company in `<ws>/hermes/profils/`, no fallback), its `.env` emptied, folders `<ws>/agents/<slug>/…`, memory and journal links, common skills, SOUL from the templates. The Hermes page shows the common folders, a « Préparer l'agent » button as a fallback, and a Telegram token field per profile (written to the profile's `.env`, mode 600, never shown again). Without that file nothing is created automatically.

## Compatibility
Tested with Hermes 0.19 and 0.21.5, on Paperclip 2026.1001.0 (plugin SDK `@paperclipai/plugin-sdk` 2026.1001.0).

**Waking agents.** Agents whose task may need a confirmation (a question to a human, an approval) must be woken by **issue assignment**, never by `POST /agents/:id/wakeup` (Paperclip issue #13704): a wakeup without an issue has no continuation context, and the continuation fails with `continuation_source_context_missing`.

## What 0.6 changes
- **Empty `.env` on prepare** (R02a): a prepared profile has no key or Telegram token inherited from the instance (`hermes profile create --clone` copies them; 0.6 replaces the file by a mode 600 comment header).
- **Preparation lock**: `<instance>/.hermes-control/prepare-<slug>.lock` (atomic `mkdir`, stale after 10 min). Two triggers at once prepare an agent once; the other gets « préparation déjà en cours ».
- **Strict company instance**: the profile is cloned only from the instance named after the company (`slug(companyName)`) in the workspace. No fallback on the first or the only instance; the error lists the instances present.
- **View without side effects**: opening the Hermes page never prepares an agent and never runs an agent's `hermesCommand`; the launcher script is read **statically** (`HERMES_HOME=…`, `$HOME`, `~`, `$PROJETC` = `<launcher dir>/../..`, literal variables above).
- **Corrupted files are refused, never rewritten**: an invalid `config.yaml` is reported (`configError`) and never written to; an invalid `agents.json` blocks `rememberAgent` with an explicit error and `recallAgent` returns null; `agents.json` is written under a lock.
- **Single Telegram gateway**: the token is refused when a `hermes-gateway*.service` unit already runs for another profile, or when another known profile already has `TELEGRAM_BOT_TOKEN` (variable names only).
- **Assignment checked before wake** (R02b): the adapter refuses an agent that is not in `agents.json` or whose profile has no `config.yaml` any more (see 1 for how to assign). `detectModel` no longer guesses from the first profile found. `HERMES_CONTROL_HERMES_BIN` selects the Hermes binary.
- **Health in three states**: per agent `installed` / `connected` / `authorized and tested` (an « État » column), and per profile the real socket path length (≤ 100 bytes), the YAML front matter of every skill (a malformed header with `platforms:` hides the skill silently) and the config readability; the plugin health is `degraded` with a short message on any alert.
- Still planned: a `doctor` check of the plugin's `localPath` registration in Paperclip, the `--yolo`/skills contract test, and the per-agent account listing.

## Security note

Hermes Control wraps the official `hermes_local` adapter, and inherits its behaviour: every Paperclip run launches `hermes chat --yolo`, i.e. **no interactive approval**, whatever `approvals.mode` says in the profile. With `terminal.backend: local`, the agent runs with the Unix user's rights, except for what the profile's `deny` list blocks — and a pattern-based deny list can be bypassed. The real protection of a Paperclip run is the `deny` list plus the execution backend (a Docker backend is the recommended target), not approvals. `hermes profile create --clone` copies the instance's `.env` (API keys, Telegram token) into the new profile; since 0.6 the prepared profile gets an empty `.env`. An empty `.env` does not remove the instance's OAuth login, hence the explicit assignment rule (R02b): one model account per assigned instance, checked before any run.

## Development
```
npm install && npm run check            # plugin: typecheck + tests + build
cd adapter && npm install && npm run check
```
Local install: `plugin install /abs/path/hermes-control` and `adapter install --payload-json '{"packageName":"/abs/path/hermes-control/adapter","isLocalPath":true}'`.

## License
MIT © Cyril M
