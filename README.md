# Hermes Control — Hermes Agent as the engine, Paperclip in charge

Source: https://github.com/CryptoDjam/hermes-control · Author: Cyril M · MIT

Run your [Paperclip](https://github.com/paperclipai/paperclip) agents on [Hermes Agent](https://github.com/NousResearch/hermes-agent) **without leaving Paperclip's own agent form**. Two small pieces, one project:

## 1. The adapter (`adapter/`) — Hermes's lists in Paperclip's menus
A drop-in **override of the built-in `hermes_local` adapter** (an official Paperclip feature: external adapters may override built-in types, with pause/resume). Everything is the official Hermes adapter, except:
- **Provider** menu (Agent → Harness / Runtime) lists the providers actually configured in your Hermes instances;
- **Model** menu lists the models Hermes knows for them (`provider_models_cache.json`);
- default model/provider (`detectModel`) come from Hermes;
- at run time, **the agent's name picks its Hermes instance/profile**: a profile with the same name (`profiles/apolline-m` for « Apolline M ») or whose description starts with the name (« Chef — … » → the `default` profile of that instance). `HERMES_HOME` is set accordingly; no launcher scripts needed.
- **Test environment** shows the instances found;
- **skills assigned in Paperclip follow the agent**: the built-in adapter links Paperclip-managed skills into `~/.hermes/skills` (it looks at `$HOME`, not `HERMES_HOME`), but Hermes only loads `$HERMES_HOME/skills`. Hermes Control links each assigned skill into `<profile>/skills/<name>` when you sync skills in Paperclip and at the start of every run, and removes the link when you unassign it (only links pointing to a Paperclip source are removed; your own skills in the profile are left alone and listed read-only). Because Paperclip's skill hooks only carry the agent id, the agent → profile map lives in `~/.config/hermes-control/agents.json` (written at run time and by the plugin's sync).

Install (local path or npm):
```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Where instances are: `~/.hermes`, plus the folders listed in `~/.config/hermes-control/roots` (one per line: an instance, or a folder of instances), plus `$HERMES_CONTROL_ROOTS`. Roll back any time: `paperclipai adapter override hermes_local` (pause) or `adapter delete hermes_local`.

## 2. The plugin — Paperclip → Hermes sync, one view
Paperclip is the master. For every Hermes agent, the plugin reads **name, working directory, provider, model, thinking** from Paperclip, finds the Hermes profile by name, and writes **provider / model / thinking** into that profile's `config.yaml` (`hermes config set`, no shell, only when different). It runs on `agent.updated` / `agent.created`, when the view is opened, and every 5 minutes.

The only UI: a sidebar link **Hermes** → the **instances** view (instance · profile · agent · provider/model sent · working directory · auth status · last sync). No settings page. The view has exactly two actions, both from 0.5 (see 3): **« Préparer l'agent »** (prepare the Hermes profile of an agent that has none) and a **Telegram** token field per profile. Note that in 0.5 *opening* the view also runs the automatic preparation when the `workspace` file exists, so it can create profiles as a side effect; 0.6 makes the view free of side effects (see the roadmap below).

```
paperclipai plugin install paperclip-plugin-hermes-control
```

## 3. With `hermes-paperclip-pack`: agents prepare themselves (0.5)
When a shared workspace is declared in `~/.config/hermes-control/workspace` (one line, written by `hermes-paperclip-pack init` — the companion pack, private for now, publication planned), a Hermes agent created in Paperclip with no matching profile is **prepared automatically**: profile cloned from the company instance, folders `<ws>/agents/<slug>/…`, memory and journal links, common skills, SOUL from the templates. The Hermes page shows the common folders, a « Préparer l'agent » button as a fallback, and a Telegram token field per profile (written to the profile's `.env`, mode 600, never shown again). Without that file nothing is created automatically.

## Compatibility
Tested with Hermes 0.19 and 0.21.5, on Paperclip 2026.1001.0 (plugin SDK `@paperclipai/plugin-sdk` 2026.1001.0).

**Waking agents.** Agents whose task may need a confirmation (a question to a human, an approval) must be woken by **issue assignment**, never by `POST /agents/:id/wakeup` (Paperclip issue #13704): a wakeup without an issue has no continuation context, and the continuation fails with `continuation_source_context_missing`.

## Roadmap (0.6, unreleased)
- Profiles prepared with an **empty `.env`** (`hermes profile create --clone` copies the instance's keys and Telegram token today — see the security note).
- A **lock** against double preparation of the same agent (two triggers at once: `agent.created` + the view).
- **Strict `companyInstance`**: the profile is cloned only from the company's own instance (several roots per company), never from the first instance found.
- The **instances view has no side effects**: opening it never creates a profile, folders or links; only `agent.created` / `agent.updated` and the « Préparer l'agent » button do.
- A **single Telegram gateway** guard: a token is refused when another profile on the machine already runs the gateway (Hermes installs one `hermes-gateway.service` per user).
- A `doctor` check that verifies the plugin's **`localPath`** registration in Paperclip (a locally installed plugin breaks silently when its folder moves) and the YAML front matter of the skills.
- **R02b — one model account per explicitly assigned instance**: an agent gets an instance only by an explicit decision of the operator; the assignment is checked before any wake; `doctor` lists which agent uses which account. An empty `.env` (R02a, first bullet) does not remove the instance's OAuth login, hence this second rule.
- The instances view **never runs the agent's `hermesCommand`** to resolve its home (`resolveHomeFromLauncher`): it reads `agents.json` and the profile files only.
- **`agents.json` writes under a lock** (the adapter at run time and the plugin's sync may write at the same time).
- `doctor` reports **three states per agent: installed / connected / authorized and tested** (a profile prepared but not connected is *installed*, not green).
- `doctor` **measures the real full socket path length** of each profile (Unix socket limit 108 bytes, target under 100) and refuses too-deep roots (seen on CDjam: "AF_UNIX path too long" on the gateway watchdog probe).

## Security note

Hermes Control wraps the official `hermes_local` adapter, and inherits its behaviour: every Paperclip run launches `hermes chat --yolo`, i.e. **no interactive approval**, whatever `approvals.mode` says in the profile. With `terminal.backend: local`, the agent runs with the Unix user's rights, except for what the profile's `deny` list blocks — and a pattern-based deny list can be bypassed. The real protection of a Paperclip run is the `deny` list plus the execution backend (a Docker backend is the recommended target), not approvals. Also note that `hermes profile create --clone` copies the instance's `.env` (API keys, Telegram token) into the new profile; 0.6 will prepare profiles with an empty `.env`.

## Development
```
npm install && npm run check            # plugin: typecheck + tests + build
cd adapter && npm install && npm run check
```
Local install: `plugin install /abs/path/hermes-control` and `adapter install --payload-json '{"packageName":"/abs/path/hermes-control/adapter","isLocalPath":true}'`.

## License
MIT © Cyril M
