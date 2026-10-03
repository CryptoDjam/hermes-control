# Hermes Control — Hermes Agent as the engine, Paperclip in charge

Source: https://github.com/CryptoDjam/hermes-control · Author: Cyril M · MIT

Run your [Paperclip](https://github.com/paperclipai/paperclip) agents on [Hermes Agent](https://github.com/NousResearch/hermes-agent) **without leaving Paperclip's own agent form**. Two small pieces, one project:

## 1. The adapter (`adapter/`) — Hermes's lists in Paperclip's menus
A drop-in **override of the built-in `hermes_local` adapter** (an official Paperclip feature: external adapters may override built-in types, with pause/resume). Everything is the official Hermes adapter, except:
- **Provider** menu (Agent → Harness / Runtime) lists the providers actually configured in your Hermes instances;
- **Model** menu lists the models Hermes knows for them (`provider_models_cache.json`);
- default model/provider (`detectModel`) come from Hermes;
- at run time, **the agent's name picks its Hermes instance/profile**: a profile with the same name (`profiles/apolline-m` for « Apolline M ») or whose description starts with the name (« Chef — … » → the `default` profile of that instance). `HERMES_HOME` is set accordingly; no launcher scripts needed.
- **Test environment** shows the instances found.

Install (local path or npm):
```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control"}'
```
Where instances are: `~/.hermes`, plus the folders listed in `~/.config/hermes-control/roots` (one per line: an instance, or a folder of instances), plus `$HERMES_CONTROL_ROOTS`. Roll back any time: `paperclipai adapter override hermes_local` (pause) or `adapter delete hermes_local`.

## 2. The plugin — Paperclip → Hermes sync, one read-only view
Paperclip is the master. For every Hermes agent, the plugin reads **name, working directory, provider, model, thinking** from Paperclip, finds the Hermes profile by name, and writes **provider / model / thinking** into that profile's `config.yaml` (`hermes config set`, no shell, only when different). It runs on `agent.updated` / `agent.created`, when the view is opened, and every 5 minutes.

The only UI: a sidebar link **Hermes** → the **instances** view (instance · profile · agent · provider/model sent · working directory · auth status · last sync). No settings page, no actions.

```
paperclipai plugin install paperclip-plugin-hermes-control
```

## Development
```
npm install && npm run check            # plugin: typecheck + tests + build
cd adapter && npm install && npm run check
```
Local install: `plugin install /abs/path/hermes-control` and `adapter install --payload-json '{"packageName":"/abs/path/hermes-control/adapter","isLocalPath":true}'`.

## License
MIT © Cyril M
