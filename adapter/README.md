# paperclip-adapter-hermes-control

The adapter half of **Hermes Control** — a drop-in override of Paperclip's built-in `hermes_local` adapter:
- the agent's **Provider** and **Model** menus list the providers and models your Hermes instances know;
- the agent runs **only in the Hermes profile assigned to it** in `~/.config/hermes-control/agents.json` (written by the plugin when it syncs or prepares the agent); `HERMES_HOME` is set to that profile, no launcher scripts. An agent with no assignment, or whose profile lost its `config.yaml`, **refuses to run** (« agent non affecté à une instance Hermes : synchronise ou prépare l'agent dans Paperclip (page Hermes) »);
- skills assigned in Paperclip are linked into `<profile>/skills`;
- *Test environment* shows the instances found.

Install into Paperclip:
```
npx paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Instances are looked up in `~/.hermes`, in the folders listed in `~/.config/hermes-control/roots` (one per line) and in `$HERMES_CONTROL_ROOTS`. Hermes binary: `$HERMES_CONTROL_HERMES_BIN` if set, else `~/.local/bin/hermes`, else `hermes` in Paperclip's PATH. Pause or remove any time: `paperclipai adapter override hermes_local` / `adapter delete hermes_local`.

Pairs with the plugin `paperclip-plugin-hermes-control` (Paperclip → Hermes sync + instances view). Source and docs: https://github.com/CryptoDjam/hermes-control

MIT © Cyril M
