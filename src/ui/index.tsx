// Interface du plugin Hermes Control (React fourni par Paperclip) : un lien « Hermes » et une seule vue, « instances ».
import React from "react";
import { useHostContext, useHostNavigation, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";

type Auth = "logged_in" | "logged_out" | "unknown";
interface Profile { name: string; home: string; description: string | null; model: string | null; provider: string | null; authStatus: Auth; approvalsMode: string | null; terminalBackend: string | null; configError: string | null }
interface Instance { name: string; home: string; dashboardUrl: string | null; profiles: Profile[]; errors24h: number; lastError: string | null }
interface Sync { agentId: string; agentName: string; instance: string | null; profile: string | null; home: string | null; want: { provider: string | null; model: string | null; thinking: string | null }; cwd: string | null; changed: string[]; error: string | null; prepared: string[] | null; at: string }
interface Workspace { root: string; profils: string; skills: string; modeles: string; agents: string }
type AgentState = "installed" | "connected" | "authorized";
interface Health { socketPathBytes: number; socketPathOk: boolean; skills: { name: string; yamlOk: boolean; hiddenByPlatforms: boolean }[]; configError: string | null; alerts: string[] }
interface Data { instances: Instance[]; sync: Sync[]; workspace: Workspace | null; telegram: Record<string, boolean>; health: Record<string, Health>; states: Record<string, AgentState> }

const STATE_LABEL: Record<AgentState, string> = { installed: "installé", connected: "connecté", authorized: "autorisé et testé" };

const S = {
  wrap: { padding: 16, display: "grid", gap: 16, fontSize: 14 } as React.CSSProperties,
  card: { border: "1px solid var(--border, #334)", borderRadius: 10, padding: 14 } as React.CSSProperties,
  muted: { opacity: 0.7, fontSize: 12 } as React.CSSProperties,
  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: { textAlign: "left" as const, padding: "6px 8px", opacity: 0.7, fontWeight: 600, borderBottom: "1px solid var(--border, #334)" },
  td: { padding: "6px 8px", borderBottom: "1px solid var(--border, #223)", verticalAlign: "top" as const },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12 },
  btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border, #334)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 } as React.CSSProperties,
  input: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border, #334)", background: "transparent", color: "inherit", fontSize: 12, width: 220 } as React.CSSProperties,
};

/* ---------- Jeton Telegram d'un profil : saisi ici, écrit dans <profil>/.env, jamais réaffiché ---------- */
function Telegram({ home, configured, onDone }: { home: string; configured: boolean; onDone: () => void }) {
  const set = usePluginAction("set-telegram");
  const toast = usePluginToast();
  const [open, setOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!open) return <span style={S.row}><span>{configured ? "configuré" : <span style={S.muted}>non</span>}</span><button style={S.btn} onClick={() => setOpen(true)}>{configured ? "changer" : "ajouter"}</button></span>;
  return (
    <form style={S.row} onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { const r = (await set({ home, token })) as { gateway?: string }; toast({ title: `Jeton Telegram enregistré. ${r.gateway ?? ""}`, tone: "success" }); setToken(""); setOpen(false); onDone(); } catch (err) { toast({ title: err instanceof Error ? err.message : String(err), tone: "error" }); } finally { setBusy(false); } }}>
      <input style={S.input} type="password" autoComplete="off" placeholder="123456789:AAAA… (jeton du bot)" value={token} onChange={(e) => setToken(e.target.value)} />
      <button style={S.btn} type="submit" disabled={busy || !token}>{busy ? "…" : "enregistrer"}</button>
      <button style={S.btn} type="button" onClick={() => { setOpen(false); setToken(""); }}>annuler</button>
    </form>
  );
}

/* ---------- Agent Paperclip sans profil Hermes : bouton « Préparer » ---------- */
function Orphan({ s, companyId, onDone }: { s: Sync; companyId: string; onDone: () => void }) {
  const prepare = usePluginAction("prepare-agent");
  const toast = usePluginToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <div style={S.row}>
      <strong>{s.agentName}</strong>
      <span style={S.muted}>{s.error ?? "aucun profil Hermes de ce nom"}</span>
      <button style={S.btn} disabled={busy} onClick={async () => { setBusy(true); try { const r = (await prepare({ agentId: s.agentId, companyId })) as { created: string[]; warnings: string[] }; toast({ title: `${s.agentName} : ${r.created.length} élément(s) créé(s)${r.warnings.length ? ` · ${r.warnings.length} avertissement(s)` : ""}`, tone: "success" }); onDone(); } catch (err) { toast({ title: err instanceof Error ? err.message : String(err), tone: "error" }); } finally { setBusy(false); } }}>{busy ? "…" : "Préparer l'agent"}</button>
    </div>
  );
}

/* ---------- État en trois valeurs : installé (profil présent) / connecté / autorisé et testé ---------- */
function State({ state }: { state: AgentState }) {
  const color = state === "authorized" ? "#22c55e" : state === "connected" ? "#eab308" : "inherit";
  return <span style={{ color }}>{STATE_LABEL[state]}</span>;
}

function Dot({ auth }: { auth: Auth }) {
  const color = auth === "logged_in" ? "#22c55e" : auth === "logged_out" ? "#ef4444" : "#eab308";
  const label = auth === "logged_in" ? "connecté" : auth === "logged_out" ? "déconnecté" : "inconnu";
  return <span title={label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 9, background: color, display: "inline-block" }} />{label}</span>;
}

/* ---------- Barre latérale : lien vers la vue ---------- */
export function HermesSidebar() {
  const nav = useHostNavigation();
  return <a {...nav.linkProps("/hermes")} style={{ display: "block", padding: "6px 10px" }}>Hermes</a>;
}

/* ---------- La vue « instances » (celle de la v0.1, telle que Cyril la voulait) ---------- */
export function HermesPage() {
  const ctx = useHostContext();
  const companyId = ctx.companyId;
  const { data, loading, error, refresh } = usePluginData<Data>("instances", { companyId });
  if (!companyId) return <div style={S.wrap}><span style={S.muted}>Choisis une entreprise.</span></div>;
  if (loading && !data) return <div style={S.wrap}><span style={S.muted}>Lecture des instances Hermes…</span></div>;
  if (error || !data) return <div style={S.wrap}><span style={{ color: "#ef4444" }}>Erreur : {error?.message ?? "pas de données"}</span></div>;
  const agentsOf = (inst: string, profile: string) => data.sync.filter((s) => s.instance === inst && s.profile === profile);
  const orphans = data.sync.filter((s) => !s.instance);
  const ws = data.workspace;
  // état d'une ligne : celui de ses agents ; sans agent, celui du profil seul (connecté ou installé)
  const stateOf = (p: Profile, agents: Sync[]): AgentState => {
    const states = agents.map((a) => data.states?.[a.agentId]).filter((x): x is AgentState => !!x);
    if (states.length) return states.includes("installed") ? "installed" : states.includes("connected") ? "connected" : "authorized";
    return p.authStatus === "logged_in" ? "connected" : "installed";
  };
  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.row}><strong style={{ fontSize: 16 }}>Dossiers communs</strong>{!ws && <span style={S.muted}>aucun dossier de travail déclaré (~/.config/hermes-control/workspace) : les agents ne sont pas préparés automatiquement</span>}</div>
        {ws && (
          <table style={{ ...S.table, marginTop: 8 }}><tbody>
            <tr><td style={S.td}>Dossier de travail</td><td style={{ ...S.td, ...S.code }}>{ws.root}</td></tr>
            <tr><td style={S.td}>Instances et profils Hermes</td><td style={{ ...S.td, ...S.code }}>{ws.profils}</td></tr>
            <tr><td style={S.td}>Skills communs (liés dans chaque profil)</td><td style={{ ...S.td, ...S.code }}>{ws.skills}</td></tr>
            <tr><td style={S.td}>Gabarits (SOUL, mémoire, fiche, instructions)</td><td style={{ ...S.td, ...S.code }}>{ws.modeles}</td></tr>
            <tr><td style={S.td}>Dossiers des agents</td><td style={{ ...S.td, ...S.code }}>{ws.agents}/&lt;agent&gt;/ (fiche, rapports, memoire, medias, journal)</td></tr>
          </tbody></table>
        )}
      </div>
      {!data.instances.length && <div style={S.card}>Aucune instance Hermes trouvée.</div>}
      {data.instances.map((inst) => (
        <div key={inst.home} style={S.card}>
          <div style={S.row}>
            <strong style={{ fontSize: 16 }}>{inst.name}</strong>
            <span style={{ ...S.muted, ...S.code }}>{inst.home}</span>
            {inst.dashboardUrl && <a href={inst.dashboardUrl} target="_blank" rel="noreferrer">tableau de bord ↗</a>}
            <span style={{ marginLeft: "auto", color: inst.errors24h ? "#ef4444" : "inherit" }}>{inst.errors24h} erreur(s) 24 h</span>
          </div>
          <table style={{ ...S.table, marginTop: 10 }}>
            <thead><tr><th style={S.th}>Profil</th><th style={S.th}>Description</th><th style={S.th}>Modèle</th><th style={S.th}>État</th><th style={S.th}>Connexion</th><th style={S.th}>Validations</th><th style={S.th}>Terminal</th><th style={S.th}>Agents Paperclip</th><th style={S.th}>Telegram</th></tr></thead>
            <tbody>
              {inst.profiles.map((p) => {
                const agents = agentsOf(inst.name, p.name);
                return (
                  <tr key={p.name}>
                    <td style={S.td}><strong>{p.name}</strong></td>
                    <td style={S.td}>{p.description ?? <span style={S.muted}>—</span>}</td>
                    <td style={S.td}><span style={S.code}>{p.provider ?? "?"}/{p.model ?? "?"}</span></td>
                    <td style={S.td}><State state={stateOf(p, agents)} /></td>
                    <td style={S.td}><Dot auth={p.authStatus} /></td>
                    <td style={S.td}><span style={{ color: p.approvalsMode === "off" ? "#ef4444" : "inherit" }}>{p.approvalsMode ?? "—"}</span></td>
                    <td style={S.td}><span style={{ color: p.terminalBackend === "local" ? "#eab308" : "inherit" }}>{p.terminalBackend ?? "—"}</span></td>
                    <td style={S.td}>{agents.length ? agents.map((a) => <span key={a.agentId} title={`${a.error ? a.error : a.changed.length ? `écrit : ${a.changed.join(", ")}` : "synchro à jour"}${a.prepared?.length ? ` · préparé : ${a.prepared.length} élément(s)` : ""}${a.cwd ? ` · dossier : ${a.cwd}` : ""}`} style={{ color: a.error ? "#ef4444" : "inherit" }}>{a.agentName}{a.prepared?.length ? " ✦" : ""}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), []) : <span style={S.muted}>aucun</span>}</td>
                    <td style={S.td}><Telegram home={p.home} configured={!!data.telegram?.[p.home]} onDone={refresh} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {inst.profiles.flatMap((p) => (data.health?.[p.home]?.alerts ?? []).map((a, i) => (
            <div key={`${p.home}-${i}`} style={{ color: "#ef4444", fontSize: 12, marginTop: 6 }}>{p.name} : {a}</div>
          )))}
          {inst.lastError && <div style={{ ...S.muted, ...S.code, marginTop: 8 }}>dernière erreur : {inst.lastError}</div>}
        </div>
      ))}
      {orphans.length > 0 && (
        <div style={{ ...S.card, borderColor: "#ef4444", display: "grid", gap: 8 }}>
          <strong style={{ color: "#ef4444" }}>Agents Hermes sans profil</strong>
          {orphans.map((s) => <Orphan key={s.agentId} s={s} companyId={companyId} onDone={refresh} />)}
          <span style={S.muted}>« Préparer l'agent » crée son profil Hermes dans l'instance de l'entreprise (celle qui porte son nom), ses dossiers dans le dossier de travail et ses liens (mémoire, journal, skills communs), avec un .env vide. Ouvrir cette page ne prépare rien.</span>
        </div>
      )}
    </div>
  );
}
