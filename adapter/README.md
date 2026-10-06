# paperclip-adapter-hermes-control

The adapter half of **Hermes Control** — a drop-in override of Paperclip's built-in `hermes_local` adapter:
- the agent's **Provider** and **Model** menus list the providers and models your Hermes instances know;
- the agent runs **only in the Hermes profile explicitly assigned to it** in `~/.config/hermes-control/assignments.json` (company → authorized instances, agent → instance / profile; written by the plugin's assignment actions, never by name); `HERMES_HOME` is set to that profile. The adapter **refuses to run** an agent with no assignment (« non affecté »), an invalid one (instance no longer authorized for the agent's company, profile claimed twice, instance outside the known roots), one recorded for another company, a profile whose `config.yaml` is absent or unreadable, a profile whose preparation was interrupted, or a profile whose watchdog socket path would exceed 100 bytes. Launcher scripts (`hermesCommand`) are read statically: any uncertainty (unresolved variable, several `HERMES_HOME`, unreadable script) or divergence from the assignment is a refusal; an approved Hermes binary (`HERMES_CONTROL_HERMES_BIN`, the table's `approvedBinaries`, or a bare name) is accepted as is. `agents.json` is only a projection of the table (same fingerprint);
- skills assigned in Paperclip are linked into `<profile>/skills`;
- *Test environment* shows the instances found.

Install into Paperclip:
```
npx paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Instances are looked up in `~/.hermes`, in the folders listed in `~/.config/hermes-control/roots` (one per line) and in `$HERMES_CONTROL_ROOTS`. Hermes binary: `$HERMES_CONTROL_HERMES_BIN` if set, else `~/.local/bin/hermes`, else `hermes` in Paperclip's PATH. Pause or remove any time: `paperclipai adapter override hermes_local` / `adapter delete hermes_local`.

Pairs with the plugin `paperclip-plugin-hermes-control` (Paperclip → Hermes sync + instances view). Source and docs: https://github.com/CryptoDjam/hermes-control

MIT © Cyril M
