# @cyberservices-ai/paperclip-adapter-hermes-control

The adapter half of **Hermes Control** — a drop-in override of Paperclip's built-in `hermes_local` adapter:
- the agent's **Provider** and **Model** menus list the providers and models your Hermes instances know;
- the agent runs **only in the Hermes profile explicitly assigned to it** in the assignments table `<reference>/assignments.json` — the reference is `<account home>/.config/hermes-control`, computed from the Unix account database (never `$HOME` nor an environment variable), the same folder the plugin reads; the table is written by the plugin's admin actions, never by name;
- **the adapter builds the Hermes command itself** (0.6.1): the administered Hermes entry point (absolute path in the table, verified before every run: owner, permissions, link target, sha256, Python interpreter and installation), `HERMES_HOME` = the administered literal execution root + `profiles/<profile>` (the root itself for `default`), an explicit environment (`config.env` cannot override `HERMES_HOME`, `PATH` or the interpreter variables). The agent's `hermesCommand`, a bare name or the `PATH` are never used to launch; no launcher script is read or run;
- it **refuses to run** an agent with no assignment (« non affecté »), an invalid one, one recorded for another company, a profile whose `config.yaml` is absent or unreadable, a profile whose preparation was interrupted, a missing or refused binary, an execution root pointing to another instance, `-p`/`--profile` in `extraArgs`, or a watchdog socket path over 100 bytes measured on the `HERMES_HOME` actually passed. A refusal is **returned** as `errorCode: "configuration_incomplete"`, which Paperclip 2026.1001.0 does not retry; Hermes is not called. `agents.json` is only a projection of the table (same fingerprint);
- skills assigned in Paperclip are linked into `<profile>/skills`;
- *Test environment* shows the instances found.

Install into Paperclip:
```
npx paperclipai adapter install --payload-json '{"packageName":"@cyberservices-ai/paperclip-adapter-hermes-control"}'
```
Instances are looked up in the account's `~/.hermes` and in the folders listed in `<reference>/roots` (one per line). Hermes binary: only the one administered in the table (`hermes.binary`). The `HERMES_CONTROL_*` variables are no longer read; if one is still set in the service, runs are refused. Pause or remove any time: `paperclipai adapter override hermes_local` / `adapter delete hermes_local`. Full configuration contract, controlled execution and rollback: see the main README.

Self-contained since 0.7.0: the two patched Paperclip modules (« voie 1 », `voie1/LICENCES.md`) are bundled into `dist/index.js` (licences: `dist/THIRD_PARTY_LICENSES.md`); the package has no install-time dependency. Before 0.7.0 the package was named `paperclip-adapter-hermes-control`: see `docs/migration-0.7.0.md` in the repository (the adapter type stays `hermes_local`).

Pairs with the plugin `@cyberservices-ai/paperclip-plugin-hermes-control` (Paperclip → Hermes sync + instances view). Source and docs: https://github.com/CyberServices-ai/hermes-control

AGPL-3.0-or-later © Cyril M, with an additional term under section 7(b) (`ADDITIONAL-TERMS.md`). Versions published up to 0.5.0 (old name) remain under MIT. Bundled third-party code keeps its own licences (`dist/THIRD_PARTY_LICENSES.md`).
