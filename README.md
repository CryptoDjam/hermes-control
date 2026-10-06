# Hermes Control — Hermes Agent as the engine, Paperclip in charge

> **Warning — `master` contains 0.6.1 in development: not published and not yet acceptance-tested.** Install **0.5.0** from npm (`paperclip-plugin-hermes-control@0.5.0`, `paperclip-adapter-hermes-control@0.5.0`). 0.5.0 does not provide the 0.6 explicit-assignment guarantees.

Source: https://github.com/CyberServices-ai/hermes-control · Author: Cyril M · MIT

Run your [Paperclip](https://github.com/paperclipai/paperclip) agents on [Hermes Agent](https://github.com/NousResearch/hermes-agent) **without leaving Paperclip's own agent form**. Two small pieces, one project:

## 1. The adapter (`adapter/`) — Hermes's lists in Paperclip's menus
A drop-in **override of the built-in `hermes_local` adapter** (an official Paperclip feature: external adapters may override built-in types, with pause/resume). Everything is the official Hermes adapter, except:
- **Provider** menu (Agent → Harness / Runtime) lists the providers actually configured in your Hermes instances;
- **Model** menu lists the models Hermes knows for them (`provider_models_cache.json`);
- default model/provider (`detectModel`) come from Hermes;
- at run time, **the agent runs only in the Hermes profile explicitly assigned to it**, and **the adapter builds the Hermes command itself** (0.6.1, see *Configuration contract* and *Controlled execution* below): the administered Hermes binary (absolute path in the table, verified before every run), `HERMES_HOME` = the administered *execution root* + `profiles/<profile>` (or the root itself for the `default` profile), an explicit environment. The agent's own `hermesCommand` / `command`, a bare name or the `PATH` are **never** used to launch Hermes; no launcher script is read or run. It **refuses to run** when the agent has no assignment (« non affecté »), when the assignment is invalid (instance no longer authorized for the agent's company, profile claimed by two agents, instance outside the known roots, execution root pointing to another instance), when it was recorded for another company than `ctx.agent.companyId`, when the profile's `config.yaml` is absent or unreadable, when the profile's preparation was interrupted, when the administered binary is missing or fails verification, when `extraArgs` carries `-p`/`--profile`, or when the watchdog socket path measured **on the `HERMES_HOME` string actually passed** would exceed 100 bytes. A refusal is **not retried** by Paperclip (see *Refusals*).
- **Test environment** shows the instances found;
- **skills assigned in Paperclip follow the agent**: the built-in adapter links Paperclip-managed skills into `~/.hermes/skills` (it looks at `$HOME`, not `HERMES_HOME`), but Hermes only loads `$HERMES_HOME/skills`. Hermes Control links each assigned skill into `<profile>/skills/<name>` when you sync skills in Paperclip and at the start of every run, and removes the link when you unassign it (only links pointing to a Paperclip source are removed; your own skills in the profile are left alone and listed read-only). Paperclip's skill hooks only carry the agent id: the adapter looks the agent up in the assignments table (the projection `agents.json` is only a fallback with the same fingerprint, rewritten whenever the table is written — never at run time).

Install (local path or npm):
```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Where instances are: the account's `~/.hermes`, plus the folders listed in `<reference>/roots` (one per line: an instance, or a folder of instances). Hermes binary: **only** the one administered in the table (`hermes.binary`, or per instance). No environment variable is read (0.6.1). Pause the adapter any time: `paperclipai adapter override hermes_local` (pause) or `adapter delete hermes_local`; for a full rollback to 0.5.0 see *Rollback*.

## 2. The plugin — explicit assignments, Paperclip → Hermes sync, one view
Paperclip is the master, and **the assignment is explicit**. For every Hermes agent the plugin reads **name, working directory, provider, model, thinking** from Paperclip, looks up its assignment in the table (never by name), and writes **provider / model / thinking** into the assigned profile's `config.yaml` (`hermes config set`, no shell, only when different; never when the `config.yaml` is unreadable). An agent without assignment gets « non affecté », nothing is written to Hermes, and the view shows a **suggestion** by name (same profile name, or a description starting with the name, restricted to the company's authorized instances) that is **never applied**. Renaming an agent changes nothing. It runs on `agent.updated` / `agent.created`, when the view is opened, and every 5 minutes.

The only UI: a sidebar link **Hermes** → the **instances** view, **filtered by company** (the company's authorized instances and the unclaimed ones, its own agents, their states, health and errors — company A sees nothing of company B). Opening it **creates no profile, folder or link, reads or runs no launcher and never writes the table**; it shows the reference (path + fingerprints), the administered binary, a hybrid or out-of-date `agents.json`, and every agent whose `hermesCommand` is now ignored. Every Hermes call of the plugin (sync `hermes config set`, `profile create`, `auth status`, `gateway install`) goes through the administered, verified binary with an explicit environment; without it nothing is executed. Its actions (board users only). **0.6.2 — authorization contract:** the company is the one Paperclip authorized for the action (`actorContext.companyId`, set after `assertCompanyAccess` on both action routes); a contradicting `params.companyId` is refused; the target agent, its assignment and the instance/profile owner are checked against that company **before any write**, and a refusal has no effect. Company actions called without a company are refused. Opening the view probes (`hermes auth status`) **only the company's authorized instances**; unclaimed instances are read light, other companies' instances are neither read nor probed.
- **« Enregistrer les instances autorisées »** (`set-company-instances`: companyId, instances) — which discovered instances this company may use. Nothing is deduced from the company's name any more. An instance still used by an assigned agent cannot be removed. **An instance already attached to another company is refused** (0.6.2: no sharing, nothing reassigned); a table that already shares an instance gets a diagnostic in both views and its shared settings (binary, execution root) are refused until the administrator keeps it in one company only.
- **« Affecter »** (`assign-agent`: agentId, companyId, instanceHome, profile) — the instance must be authorized for the company, the profile must exist in it (or be the agent's slug, « à préparer »), and no other agent may already hold it. Recorded with `assignedBy: user:<id>` and `assignedAt`.
- **« Préparer et affecter »** / **« Préparer l'agent »** (`prepare-agent`: agentId, companyId, instanceHome) — creates the profile (`hermes profile create --clone`, then an **empty `.env`**) in the **explicitly chosen** authorized instance, its folders and links, and assigns the agent at the same time; for an already-assigned agent it finishes an interrupted preparation.
- **« Désaffecter »** (`unassign-agent`: agentId) — only an agent of the company whose assignment belongs to the company (or an orphan assignment of the company).
- a **Telegram** token field per profile (`set-telegram`: agentId, token, home?) — for an **agent** of the company, assigned for it, in an instance it alone owns; the profile written is the assignment's (0.6.2: no more free path); the gateway is installed with the profile's execution `HERMES_HOME`.
- `set-hermes-binary` (binary, linkTarget?, sha256?, instanceHome?) — the administered Hermes entry point, verified before it is written. **Global** (no `instanceHome`): only through a call **without company** (`POST /api/plugins/<id>/actions/set-hermes-binary` or `/bridge/action` with no `companyId`), which Paperclip only lets an instance admin through; refused in any company scope (the plugin page always sends its company). **Per instance**: an instance owned by the company (or an admin call), not shared. No UI form yet.
- `set-execution-root` (companyId, instanceHome, executionRoot) — the literal, short execution root of an authorized instance (`~/.h/d`); it must resolve (`realpath`) to the same instance.

### How to assign the agents (first time, or after the migration)
1. Open the Hermes page for the company, tick its **authorized instances**, save.
2. For each agent, pick the instance and the profile (the suggestion helps, the choice is yours), click **Affecter**; or **Préparer et affecter** to create a fresh profile named after the agent.
3. The adapter starts the agent only once the assignment is valid and the profile usable.

### Migration of existing agents (`scripts/migrate-assignments.mjs`)
The old `agents.json` was produced by name and is **not** converted blindly. `npm run build` then, from the repository:
`node scripts/migrate-assignments.mjs --paperclip-data <paperclip>/data/instances/default/data --agent-commands <agents export.json> --hermes-binary <install>/.venv/bin/hermes [--execution-root <instance>=~/.h/<x>] [--confirm <agentId>=<instance>:<profile>] [--company-name <id>=<Name>]`
prints, read-only, one row per agent — companyId, agentId, name, instance, real profile, the agent's `hermesCommand`, the `HERMES_HOME` that will be passed, model-account label (never a secret value), socket length —, every **disagreement** and **warning**, and the proposed table. **No launcher is run or read to authorize anything**: the `bin/` folders are only inventoried (path, sha256); files that are not launchers are ignored; a launcher **referenced by an agent** (from the Paperclip agents export) is shown and blocks `--apply` until an explicit mapping `--confirm <agentId>=<instance>:<profile>` is given, validated against the existing instances and profiles. Nothing is written without `--apply`; `--apply` is refused while a disagreement remains and backs up `assignments.json` / `agents.json` first. Keep the backups for the rollback.

Files (the *reference*, see below): `<reference>/assignments.json` (the table, mode 600), `<reference>/agents.json` (projection), `<reference>/roots`, `<reference>/workspace`. With `hermes-paperclip-pack`, `donnees/identites.json` is meant to become the reference and this table its import; the two must never be maintained in parallel (see `pack/CONTRACTS.md` §1–2).

## Configuration contract (0.6.1)
**One reference, shared by the plugin and the adapter**: the folder `<account home>/.config/hermes-control/`, where `<account home>` is the home directory of the Unix account that runs Paperclip **as given by the system account database** (`getpwuid`, Node `os.userInfo().homedir`) — never `$HOME`, never an environment variable. Why: Paperclip 2026.1001.0 starts the plugin worker with a filtered environment (`PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ` and the deployment mode — no `HOME`, none of the service's variables; `plugin-worker-manager.js`), while the adapter runs inside the server with the full service environment. Anything read from the environment could make the two components read two different files; the account database gives both the same folder by construction (same uid).

**The old variables are no longer read**: `HERMES_CONTROL_ASSIGNMENTS`, `HERMES_CONTROL_AGENTS_MAP`, `HERMES_CONTROL_ROOTS`, `HERMES_CONTROL_WORKSPACE`, `HERMES_CONTROL_HERMES_BIN`. (0.6.0's CHANGELOG wrongly said that the worker honored `HERMES_CONTROL_HERMES_BIN`: the worker never receives it.) If one of them is still set where the adapter runs, an administrator expected another reference: **every run is refused** with a message naming the reference, instead of silently falling back on the account folder; the adapter's *Test environment* reports it (the plugin worker never receives these variables, so it cannot see them).

**Two Paperclip installations under the same Unix account share the same reference.** To isolate a test installation, run it under another account or in a mount namespace (`bwrap`) that binds another folder on `~/.config/hermes-control` — as the 0.6 acceptance test did.

**The table** `<reference>/assignments.json`:
```json
{ "schemaVersion": 1,
  "hermes":    { "binary": "/home/u/.local/share/hermes-0.21/hermes-agent/.venv/bin/hermes", "linkTarget": "…if binary is a symlink", "sha256": "…optional, enforced" },
  "instances": { "/home/u/Projects/X/hermes/profils/direction": { "executionRoot": "~/.h/d", "hermes": { "binary": "…optional, per instance" } } },
  "companies": { "<companyId>": { "name": "ACME", "instances": ["/home/u/Projects/X/hermes/profils/direction"] } },
  "agents":    { "<agentId>": { "companyId": "<companyId>", "instanceHome": "/home/u/Projects/X/hermes/profils/direction", "profile": "chef", "name": "Chef", "assignedAt": "…", "assignedBy": "user:…" } } }
```
- `instanceHome` and the keys of `instances` are **canonical** roots (`realpath`): used to verify (authorized instance, profile claimed once, inside a known root).
- `executionRoot` is the **literal** root passed to Hermes (absolute, or `~/…` expanded explicitly from the account home; no `.` / `..`): it must resolve to the same instance. Without it, the canonical root is passed.
- `HERMES_HOME` = `executionRoot/profiles/<profile>`, or `executionRoot` itself for the `default` profile (unchanged from 0.6.0's `profileHome`), and its `realpath` must be exactly the assigned canonical profile (a `profiles/<p>` symlinked elsewhere is refused). The socket paths are measured on that string.
- `approvedBinaries` (0.6.0) no longer exists: a table that contains it is refused with an explicit message.
- **Who writes it**: the plugin's admin actions (`set-company-instances`, `assign-agent`, `unassign-agent`, `prepare-agent`, `set-hermes-binary`, `set-execution-root`), the migration script with `--apply`, or the administrator by hand (validated on every read; a corrupted table is refused, never rewritten). The projection `agents.json` is rewritten with every table write.
- **Diagnostic**: the adapter's *Test environment* (`hermes_control.reference`), the plugin's health and the instances view show the reference path, the account it comes from and the sha256 of `assignments.json`, `roots`, `workspace`, `agents.json` (no secret).

## Controlled execution (0.6.1)
The adapter builds the command itself, before calling the official `hermes_local` adapter:
- **binary** = the administered entry point (per instance, else global), verified before any call (even before a `--version`): absolute normalized path; regular file, or a symlink whose real target is the one written in `linkTarget`; owned by the current user; not writable by group/others (file and its folder); executable; sha256 computed (and enforced when the table gives one); format = ELF, or a **Python script with an absolute shebang** — Hermes's official entry point `<install>/.venv/bin/hermes` — whose interpreter is checked (exists, regular file, owned by the user or root, not writable by group/others) and recorded with its installation (`pyvenv.cfg`). A shell script (bash, sh…, i.e. the old launchers and the Omarchy wrapper `~/.local/bin/hermes`), a shebang through `env`, any other format → refused. The verification does not cover the Python modules the entry point imports: the installation is logged for the acceptance test.
- **`hermesCommand` / `command` of the agent** → replaced by the administered binary (logged as « ignorée »).
- **environment** (merged by the official adapter over the server's environment): `config.env` of the agent minus the reserved keys (`HERMES_HOME`, `PATH`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PYTHONUSERBASE`, `PYTHONINSPECT`, `VIRTUAL_ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `BASH_ENV`, `ENV`, Hermes supervisor/update flags), then `HERMES_HOME` (literal) and `PATH` = interpreter folder first + the server's `PATH`; the reserved interpreter keys are set to an empty value (ignored by CPython and ld.so) so the server's own values cannot leak in. Other keys (API keys, `HERMES_*` options) pass as before.
- **arguments**: `extraArgs` with `-p` / `--profile` is refused (Hermes would switch profile after the check); for the `default` profile, an `active_profile` file that would redirect Hermes is refused.
- Launcher scripts stay usable by hand; Paperclip no longer uses them.

## Refusals are not retried
Paperclip 2026.1001.0 turns an exception thrown by `execute` into `errorCode: "adapter_failed"`, which its recovery classifies as `transient_infra` and re-schedules (`scheduled_retry`). A configuration refusal is therefore **returned**, not thrown: `{ exitCode: null, errorMessage, errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "hermes_control_<kind>", fingerprint, … } } }`. The server stores `errorCode = "configuration_incomplete"`; its recovery (`classifyAdapterFailureForRecovery`) classifies it `configuration_incomplete` and moves the issue to `blocked` for a human instead of retrying; no bounded transient retry applies (no `errorFamily`). Unexpected errors (disk, the official adapter itself) are still thrown and stay retryable.

## Rollback (0.6.x → 0.5.0)
**A clean return to 0.5.0 that keeps the explicit assignments is impossible in general.** 0.5.0 has no assignment table: its adapter picks the profile **by the agent's name** at every run, across all instances, and reads `agents.json` (flat map) only for skills. After a rollback, an agent with a namesake in another instance runs in the wrong instance (wrong model account), a renamed agent no longer runs, and an agent that is **not assigned** in 0.6 (refused) **starts running again** in whatever profile its name matches. 0.5.0 also writes flat entries into `agents.json`, which becomes **hybrid** (0.6.x detects and reports it, and ignores it).

What is automated (read-only by default, `npm run build` first), **with mutations stopped** (no agent created or renamed, no plugin action) from the export to the reinstall:
1. `scripts/export-agents.mjs --api http://127.0.0.1:3100/api --out agents.json` — run by an **instance admin** (a limited user does not see every company or agent): `GET /companies`, then `GET /companies/:id/agents`; keeps id, name, company, adapter type, status and `hermesCommand` only; records `collectedAt`, per company `agentCount`, and whether the collector is an instance admin (`GET /admin/users` → 200; otherwise the rollback refuses the export). The API excludes terminated agents. Cross-check if needed, database stopped for writes: `SELECT id, name, company_id, adapter_type, status FROM agents`.
2. `scripts/rollback-to-0.5.mjs --agents agents.json` (0.6.2): the export is **mandatory** and checked — recognized format, fresh (default ≤ 30 min, `--max-age-minutes`) and not older than `assignments.json`, no duplicate company/agent, `agentCount` equal to the listed agents, every company and agent of the table present, name/company/adapter type present; then 0.5's name rule (same `matchAgent` code) is simulated for **every `hermes_local` agent of every company**, assigned or not;
3. verdict per agent: identical / other profile (namesake, description) / no profile (renamed) for assigned agents; for unassigned agents: found by name (**blocking**: 0.5 would run it) or not found (warning: the run fails, Hermes is not started); **compatible** only without any blocker;
4. `--apply`, only if compatible: backs up `agents.json` and `assignments.json` (`*.bak-rollback-<date>`), writes the flat 0.5 map derived from the table (for skills); `assignments.json` is kept untouched (0.5 ignores it; it allows going back to 0.6.x). Refused `--apply`: a message and exit code 2, nothing written;
5. it prints the package commands for the administrator (nothing is installed by the script; to be checked in the acceptance test): `paperclipai plugin uninstall hermes-control` (without `--force`), `paperclipai plugin install paperclip-plugin-hermes-control@0.5.0`, `paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control","version":"0.5.0"}'`. 0.6.x does not modify the agents' `hermesCommand`; 0.5 needs them as they were (launchers).

When the verdict is incompatible — the normal case with namesakes or renamed agents — **restore everything from the cold backup** taken before installing 0.6.1, Paperclip stopped:
- Paperclip's database and data folder (`<data-dir>`, including `adapter-plugins/` and `adapter-plugins.json`), and `~/.paperclip/plugins` (the installed plugin);
- `~/.config/hermes-control/` (0.5's `agents.json`, `roots`, `workspace`);
- the Hermes instances (profiles, `config.yaml`, `.env`, `state.db`, memories) and the launchers `bin/`.
Everything done after the backup point is lost: Paperclip issues, comments, runs and agent changes; Hermes sessions, memories and profile changes; profiles prepared by 0.6.1. The restored state is a configuration already known to work with 0.5 — it does not make 0.5 handle namesakes correctly. Then restart Paperclip and check every agent's profile (run log line « → Hermes <instance>/<profile> ») before reopening the work.

```
paperclipai plugin install paperclip-plugin-hermes-control
```

## 3. With `hermes-paperclip-pack`: profiles prepared with an empty `.env` (0.5, hardened in 0.6)
When a shared workspace is declared in `~/.config/hermes-control/workspace` (one line, written by `hermes-paperclip-pack init` — the companion pack, private for now), **« Préparer et affecter »** clones the profile from the **explicitly chosen** authorized instance, empties its `.env`, creates `<ws>/agents/<slug>/…`, the memory and journal links, the common skills and the SOUL from the templates. Preparation writes a durable state `<instance>/.hermes-control/preparing-<slug>.json` **before** the clone and removes it only after the `.env` is cleaned and the markers are set; an interrupted or failed preparation leaves the profile **unusable** (the adapter refuses it) until « Préparer l'agent » is run again. Since this release nothing is prepared automatically on `agent.created` / `agent.updated`: an instance is never chosen by default. Without the workspace file nothing can be prepared.

## Compatibility
Tested with Hermes 0.19 and 0.21.5, on Paperclip 2026.1001.0 (plugin SDK `@paperclipai/plugin-sdk` 2026.1001.0).

**Waking agents.** Agents whose task may need a confirmation (a question to a human, an approval) must be woken by **issue assignment**, never by `POST /agents/:id/wakeup` (Paperclip issue #13704): a wakeup without an issue has no continuation context, and the continuation fails with `continuation_source_context_missing`.

## What 0.6.1 changes (after the 0.6 acceptance test)
- **Controlled execution**: the adapter builds the command (administered, verified binary; literal `HERMES_HOME`; explicit environment); launchers and the agent's `hermesCommand` are never run or read; bare names are no longer « approved ».
- **One reference** for the plugin and the adapter, from the account database, no environment variable; old variables → refusal; diagnostic with path and fingerprints.
- **Manifest** description ≤ 500 characters, the whole manifest validated against Paperclip's real schema in the tests.
- **Refusals not retried** (`configuration_incomplete`).
- **Rollback** documented and partly automated; clean return declared impossible with namesakes / renamed agents.
- **Integration**: hybrid `agents.json` detected and reported; migration ignores foreign files, never runs or reads launchers, requires an explicit mapping for a referenced launcher; `instances` data filtered by company (states, errors included); messages show `inst/a/profiles/chef`.

## What 0.6 changes
- **Explicit assignments table** (`assignments.json`): company → authorized instances, agent → instance / profile, validated on read and write (authorized instance, no profile claimed twice, `realpath` inside a known root), written only by the assignment actions and the migration script; `agents.json` is a derived projection with the table's fingerprint. **No assignment by name**: not when the view opens, not at sync, not on rename — only a suggestion.
- **Empty `.env` on prepare** (R02a) with a **durable preparing state** written before the clone; a partial or interrupted preparation leaves the profile unusable until cleaned. A profile made by hand is never emptied.
- **Preparation lock** and every other lock are **lease locks**: `owner.json` (pid, host, token, renewedAt), renewed every 5 s; reclaimed only when the lease is stale and the owner dead or remote; released only by its token.
- **View that creates nothing, runs nothing and assigns nothing** (in 0.6.0 the launcher script was read statically; replaced in 0.6.1 by the controlled execution, see above).
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
Tests never touch the real reference: `vitest.setup.ts` redirects the account home to a temporary `$HOME` and fails a test that would point at the real one.

## License
MIT © Cyril M
