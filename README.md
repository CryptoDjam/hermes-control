# Hermes Control — Hermes Agent as the engine, Paperclip in charge

Source: https://github.com/CryptoDjam/hermes-control · Author: Cyril M · MIT

Run your [Paperclip](https://github.com/paperclipai/paperclip) agents on [Hermes Agent](https://github.com/NousResearch/hermes-agent) **without leaving Paperclip's own agent form**. Two small pieces, one project:

## 1. The adapter (`adapter/`) — Hermes's lists in Paperclip's menus
A drop-in **override of the built-in `hermes_local` adapter** (an official Paperclip feature: external adapters may override built-in types, with pause/resume). Everything is the official Hermes adapter, except:
- **Provider** menu (Agent → Harness / Runtime) lists the providers actually configured in your Hermes instances;
- **Model** menu lists the models Hermes knows for them (`provider_models_cache.json`);
- default model/provider (`detectModel`) come from Hermes;
- at run time, **the agent runs only in the Hermes profile explicitly assigned to it** (0.6): the adapter reads the assignments table `~/.config/hermes-control/assignments.json` (company → authorized instances; agent → instance / profile; written only by the plugin's assignment actions, **never by name**) and sets `HERMES_HOME` to that profile. It **refuses to run** when the agent has no assignment (« non affecté »), when the assignment is invalid (instance no longer authorized for the agent's company, profile claimed by two agents, instance outside the known roots), when it was recorded for another company than `ctx.agent.companyId`, when the profile's `config.yaml` is absent or unreadable, when the profile's preparation was interrupted (`preparing-*` state, or created by Hermes Control without `env-cleaned`), or when the watchdog socket path would exceed 100 bytes. Launcher scripts (`hermesCommand`) remain the rule in production: a launcher does `export HERMES_HOME=…` itself, so the adapter reads it statically and refuses **any uncertainty** (unresolved variable, several `HERMES_HOME`, unreadable script) and any divergence from the assignment; an **approved Hermes binary** (`HERMES_CONTROL_HERMES_BIN`, the table's `approvedBinaries`, or a bare command name) is accepted as is. `agents.json` is only a projection of the table (same fingerprint) used as a fallback.
- **Test environment** shows the instances found;
- **skills assigned in Paperclip follow the agent**: the built-in adapter links Paperclip-managed skills into `~/.hermes/skills` (it looks at `$HOME`, not `HERMES_HOME`), but Hermes only loads `$HERMES_HOME/skills`. Hermes Control links each assigned skill into `<profile>/skills/<name>` when you sync skills in Paperclip and at the start of every run, and removes the link when you unassign it (only links pointing to a Paperclip source are removed; your own skills in the profile are left alone and listed read-only). Because Paperclip's skill hooks only carry the agent id, the agent → profile map lives in `~/.config/hermes-control/agents.json` (written at run time and by the plugin's sync).

Install (local path or npm):
```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Where instances are: `~/.hermes`, plus the folders listed in `~/.config/hermes-control/roots` (one per line: an instance, or a folder of instances), plus `$HERMES_CONTROL_ROOTS`. Hermes binary: `$HERMES_CONTROL_HERMES_BIN` if set, else `~/.local/bin/hermes`, else `hermes` in Paperclip's PATH. Roll back any time: `paperclipai adapter override hermes_local` (pause) or `adapter delete hermes_local`.

## 2. The plugin — explicit assignments, Paperclip → Hermes sync, one view
Paperclip is the master, and **the assignment is explicit**. For every Hermes agent the plugin reads **name, working directory, provider, model, thinking** from Paperclip, looks up its assignment in the table (never by name), and writes **provider / model / thinking** into the assigned profile's `config.yaml` (`hermes config set`, no shell, only when different; never when the `config.yaml` is unreadable). An agent without assignment gets « non affecté », nothing is written to Hermes, and the view shows a **suggestion** by name (same profile name, or a description starting with the name, restricted to the company's authorized instances) that is **never applied**. Renaming an agent changes nothing. It runs on `agent.updated` / `agent.created`, when the view is opened, and every 5 minutes.

The only UI: a sidebar link **Hermes** → the **instances** view. Opening it **creates no profile, folder or link, runs no launcher and never writes the table**. Its actions (board users only):
- **« Enregistrer les instances autorisées »** (`set-company-instances`: companyId, instances) — which discovered instances this company may use. Nothing is deduced from the company's name any more. An instance still used by an assigned agent cannot be removed.
- **« Affecter »** (`assign-agent`: agentId, companyId, instanceHome, profile) — the instance must be authorized for the company, the profile must exist in it (or be the agent's slug, « à préparer »), and no other agent may already hold it. Recorded with `assignedBy: user:<id>` and `assignedAt`.
- **« Préparer et affecter »** / **« Préparer l'agent »** (`prepare-agent`: agentId, companyId, instanceHome) — creates the profile (`hermes profile create --clone`, then an **empty `.env`**) in the **explicitly chosen** authorized instance, its folders and links, and assigns the agent at the same time; for an already-assigned agent it finishes an interrupted preparation.
- **« Désaffecter »** (`unassign-agent`).
- a **Telegram** token field per profile (`set-telegram`).

### How to assign the agents (first time, or after the migration)
1. Open the Hermes page for the company, tick its **authorized instances**, save.
2. For each agent, pick the instance and the profile (the suggestion helps, the choice is yours), click **Affecter**; or **Préparer et affecter** to create a fresh profile named after the agent.
3. The adapter starts the agent only once the assignment is valid and the profile usable.

### Migration of existing agents (`scripts/migrate-assignments.mjs`)
The old `agents.json` was produced by name and is **not** converted blindly. `npm run build` then
`node scripts/migrate-assignments.mjs --paperclip-data <paperclip>/data/instances/default/data [--company-name <id>=<Name>]`
prints, read-only, one row per agent — companyId, agentId, name, instance, real profile, launcher, statically read `HERMES_HOME`, binary, model-account label (never a secret value) —, every **disagreement** (unknown company, instance outside the roots, no or several launchers, unreadable launcher, missing `config.yaml`, profile claimed twice) and **warning** (socket path over 100 bytes: the adapter will refuse that profile), and the proposed table. Nothing is written without `--apply`; `--apply` is refused while a disagreement remains and backs up `assignments.json` / `agents.json` first. Keep the backups for the rollback.

Files: `~/.config/hermes-control/assignments.json` (the table, mode 600; `HERMES_CONTROL_ASSIGNMENTS` overrides), `~/.config/hermes-control/agents.json` (projection; `HERMES_CONTROL_AGENTS_MAP`). With `hermes-paperclip-pack`, `donnees/identites.json` is meant to become the reference and this table its import; the two must never be maintained in parallel (see `pack/CONTRACTS.md` §1–2).

```
paperclipai plugin install paperclip-plugin-hermes-control
```

## 3. With `hermes-paperclip-pack`: profiles prepared with an empty `.env` (0.5, hardened in 0.6)
When a shared workspace is declared in `~/.config/hermes-control/workspace` (one line, written by `hermes-paperclip-pack init` — the companion pack, private for now), **« Préparer et affecter »** clones the profile from the **explicitly chosen** authorized instance, empties its `.env`, creates `<ws>/agents/<slug>/…`, the memory and journal links, the common skills and the SOUL from the templates. Preparation writes a durable state `<instance>/.hermes-control/preparing-<slug>.json` **before** the clone and removes it only after the `.env` is cleaned and the markers are set; an interrupted or failed preparation leaves the profile **unusable** (the adapter refuses it) until « Préparer l'agent » is run again. Since this release nothing is prepared automatically on `agent.created` / `agent.updated`: an instance is never chosen by default. Without the workspace file nothing can be prepared.

## Compatibility
Tested with Hermes 0.19 and 0.21.5, on Paperclip 2026.1001.0 (plugin SDK `@paperclipai/plugin-sdk` 2026.1001.0).

**Waking agents.** Agents whose task may need a confirmation (a question to a human, an approval) must be woken by **issue assignment**, never by `POST /agents/:id/wakeup` (Paperclip issue #13704): a wakeup without an issue has no continuation context, and the continuation fails with `continuation_source_context_missing`.

## What 0.6 changes
- **Explicit assignments table** (`assignments.json`): company → authorized instances, agent → instance / profile, validated on read and write (authorized instance, no profile claimed twice, `realpath` inside a known root), written only by the assignment actions and the migration script; `agents.json` is a derived projection with the table's fingerprint. **No assignment by name**: not when the view opens, not at sync, not on rename — only a suggestion.
- **Empty `.env` on prepare** (R02a) with a **durable preparing state** written before the clone; a partial or interrupted preparation leaves the profile unusable until cleaned. A profile made by hand is never emptied.
- **Preparation lock** and every other lock are **lease locks**: `owner.json` (pid, host, token, renewedAt), renewed every 5 s; reclaimed only when the lease is stale and the owner dead or remote; released only by its token.
- **View that creates nothing, runs nothing and assigns nothing**: the launcher script is read **statically**; any uncertainty is an error.
- **Launcher uncertainty refused by the adapter**: unresolved variable, several `HERMES_HOME`, unreadable script → refusal; approved binaries (`HERMES_CONTROL_HERMES_BIN`, `approvedBinaries`, bare name) are accepted as is.
- **Corrupted files are refused, never rewritten**: `config.yaml`, `assignments.json`, `agents.json`.
- **Single Telegram gateway** guard.
- **Assignment checked before wake** (R02b): the adapter refuses an unassigned agent, an invalid assignment, another company's assignment, a missing or unreadable `config.yaml`, an unusable profile, a too-long socket path.
- **Health in three states**: `installed` / `connected` / **`connecté et synchronisé`** (connected + last sync without error). « Autorisé et testé » (rights, assignment, negative case) is still planned. Per profile: the real paths of the pinned version's sockets (`gateway.sock`, `state/gateway.loop-tick.<7-digit pid>.sock`, every `*.sock` present) measured before any start (≤ 100 bytes), the YAML front matter of every skill, the config readability.
- Still planned: a `doctor` check of the plugin's `localPath` registration, the `--yolo`/skills contract test, the per-agent account listing, launchers generated from a manifest, import of the table into the pack's `identites.json`.

## Security note

Hermes Control wraps the official `hermes_local` adapter, and inherits its behaviour: every Paperclip run launches `hermes chat --yolo`, i.e. **no interactive approval**, whatever `approvals.mode` says in the profile. With `terminal.backend: local`, the agent runs with the Unix user's rights, except for what the profile's `deny` list blocks — and a pattern-based deny list can be bypassed. The real protection of a Paperclip run is the `deny` list plus the execution backend (a Docker backend is the recommended target), not approvals. `hermes profile create --clone` copies the instance's `.env` (API keys, Telegram token) into the new profile; since 0.6 the prepared profile gets an empty `.env`, and the profile stays unusable until that cleanup has succeeded. An empty `.env` does not remove the instance's OAuth login, hence the explicit assignment rule (R02b): one model account per assigned instance, assigned explicitly and checked before any run.

## Development
```
npm install && npm run check            # plugin: typecheck + tests + build
cd adapter && npm install && npm run check
```
Local install: `plugin install /abs/path/hermes-control` and `adapter install --payload-json '{"packageName":"/abs/path/hermes-control/adapter","isLocalPath":true}'`.

## License
MIT © Cyril M
