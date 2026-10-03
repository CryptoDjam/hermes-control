# paperclip-adapter-hermes-control

The adapter half of **Hermes Control** — a drop-in override of Paperclip's built-in `hermes_local` adapter:
- the agent's **Provider** and **Model** menus list the providers and models your Hermes instances know;
- the **agent name picks its Hermes instance/profile** at run time (`HERMES_HOME`), no launcher scripts;
- *Test environment* shows the instances found.

Install into Paperclip:
```
npx paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Instances are looked up in `~/.hermes`, in the folders listed in `~/.config/hermes-control/roots` (one per line) and in `$HERMES_CONTROL_ROOTS`. Pause or remove any time: `paperclipai adapter override hermes_local` / `adapter delete hermes_local`.

Pairs with the plugin `paperclip-plugin-hermes-control` (Paperclip → Hermes sync + instances view). Source and docs: https://github.com/CryptoDjam/hermes-control

MIT © Cyril M
