# Texte prêt pour le Paperclip Hub et awesome-paperclip

**Name**: Hermes Control
**npm**: paperclip-plugin-hermes-control (+ companion adapter: paperclip-adapter-hermes-control)
**Author**: Cyril M (npm: cyberservices-ai · GitHub: CyberServices-ai)
**Repository**: https://github.com/CyberServices-ai/hermes-control
**Categories**: automation, ui
**License**: MIT

**Short description** (≤ 160 chars):
Run Paperclip agents on Hermes Agent, Paperclip in charge: the agent name picks its Hermes profile; Provider/Model menus list what Hermes knows.

**Long description**:
Hermes Control makes Hermes Agent the engine behind your Paperclip agents without leaving Paperclip's own agent form. The companion adapter overrides the built-in `hermes_local` adapter so the Provider and Model menus list the providers and models your Hermes instances actually know, and each agent runs on the Hermes instance/profile that carries its name (HERMES_HOME set automatically — no launcher scripts). The plugin keeps Hermes in sync with Paperclip: provider, model and thinking chosen in the agent menu are written to that profile's config.yaml, and a read-only "instances" view shows every instance, profile, auth status and which agent runs where. No settings pages, no shell commands, no secrets read.

**awesome-paperclip line**:
- [Hermes Control](https://github.com/CyberServices-ai/hermes-control) — Hermes Agent as the engine, Paperclip in charge: name → Hermes profile, Hermes providers/models in the agent form, Paperclip → Hermes sync, instances view.
