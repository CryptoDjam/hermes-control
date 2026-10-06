// Interface du plugin Hermes Control (React fourni par Paperclip) : un lien « Hermes » et une seule vue, « instances ».
// Affectation EXPLICITE : la vue montre l'affectation de chaque agent (table assignments.json) et une suggestion par le nom,
// jamais appliquée ; l'administrateur affecte, désaffecte, prépare (instance explicite) et déclare les instances autorisées.
import React from "react";
import { useHostContext, useHostNavigation, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";

type Auth = "logged_in" | "logged_out" | "unknown";
interface Profile { name: string; home: string; description: string | null; model: string | null; provider: string | null; authStatus: Auth; approvalsMode: string | null; terminalBackend: string | null; configError: string | null }
interface Instance { name: string; home: string; dashboardUrl: string | null; profiles: Profile[]; errors24h: number; lastError: string | null }
interface Assignment { instanceHome: string; profile: string; assignedAt: string; assignedBy: string }
interface Suggestion { instance: string; instanceHome: string; profile: string; by: "profile-name" | "description" }
interface Sync { agentId: string; companyId: string; agentName: string; instance: string | null; profile: string | null; home: string | null; assignment: Assignment | null; suggestion: Suggestion | null; want: { provider: string | null; model: string | null; thinking: string | null }; cwd: string | null; changed: string[]; error: string | null; prepared: string[] | null; at: string }
interface Workspace { root: string; profils: string; skills: string; modeles: string; agents: string }
type AgentState = "installed" | "connected" | "synced";
interface Health { socketPathBytes: number; socketPathOk: boolean; longest: string; skills: { name: string; yamlOk: boolean; hiddenByPlatforms: boolean }[]; configError: string | null; alerts: string[] }
interface Company { name: string; instances: string[] }
interface Assignments { file: string; error: string | null; company: Company | null; issues: { companies: Record<string, string>; agents: Record<string, string> } }
interface Data { instances: Instance[]; sync: Sync[]; workspace: Workspace | null; telegram: Record<string, boolean>; health: Record<string, Health>; states: Record<string, AgentState>; assignments: Assignments }

const STATE_LABEL: Record<AgentState, string> = { installed: "installé", connected: "connecté", synced: "connecté et synchronisé" };

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
  select: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border, #334)", background: "transparent", color: "inherit", fontSize: 12 } as React.CSSProperties,
};

function useAct() {
  const toast = usePluginToast();
  const [busy, setBusy] = React.useState(false);
  const run = async (fn: () => Promise<string>, onDone: () => void) => {
    setBusy(true);
    try {
      toast({ title: await fn(), tone: "success" });
      onDone();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/* ---------- Jeton Telegram d'un profil : saisi ici, écrit dans <profil>/.env, jamais réaffiché ---------- */
function Telegram({ home, configured, onDone }: { home: string; configured: boolean; onDone: () => void }) {
  const set = usePluginAction("set-telegram");
  const { busy, run } = useAct();
  const [open, setOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  if (!open) return <span style={S.row}><span>{configured ? "configuré" : <span style={S.muted}>non</span>}</span><button style={S.btn} onClick={() => setOpen(true)}>{configured ? "changer" : "ajouter"}</button></span>;
  return (
    <form style={S.row} onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = (await set({ home, token })) as { gateway?: string }; setToken(""); setOpen(false); return `Jeton Telegram enregistré. ${r.gateway ?? ""}`; }, onDone); }}>
      <input style={S.input} type="password" autoComplete="off" placeholder="123456789:AAAA… (jeton du bot)" value={token} onChange={(e) => setToken(e.target.value)} />
      <button style={S.btn} type="submit" disabled={busy || !token}>{busy ? "…" : "enregistrer"}</button>
      <button style={S.btn} type="button" onClick={() => { setOpen(false); setToken(""); }}>annuler</button>
    </form>
  );
}

/* ---------- Instances autorisées de l'entreprise (table assignments.json) ---------- */
function CompanyInstances({ companyId, all, company, onDone }: { companyId: string; all: Instance[]; company: Company | null; onDone: () => void }) {
  const set = usePluginAction("set-company-instances");
  const { busy, run } = useAct();
  const [chosen, setChosen] = React.useState<string[]>(company?.instances ?? []);
  React.useEffect(() => { setChosen(company?.instances ?? []); }, [company?.instances.join("|")]);
  const toggle = (home: string) => setChosen((c) => (c.includes(home) ? c.filter((x) => x !== home) : [...c, home]));
  return (
    <div style={S.card}>
      <div style={S.row}><strong style={{ fontSize: 16 }}>Instances autorisées de l'entreprise</strong><span style={S.muted}>un agent ne peut être affecté qu'à une instance cochée ici ; rien n'est déduit du nom de l'entreprise</span></div>
      {!all.length && <div style={S.muted}>aucune instance découverte (~/.config/hermes-control/roots)</div>}
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        {all.map((i) => (
          <label key={i.home} style={S.row}><input type="checkbox" checked={chosen.includes(i.home)} onChange={() => toggle(i.home)} /><strong>{i.name}</strong><span style={{ ...S.muted, ...S.code }}>{i.home}</span>{company?.instances.includes(i.home) && <span style={S.muted}>(autorisée)</span>}</label>
        ))}
      </div>
      <div style={{ ...S.row, marginTop: 8 }}>
        <button style={S.btn} disabled={busy} onClick={() => void run(async () => { await set({ companyId, instances: chosen }); return `${chosen.length} instance(s) autorisée(s) pour l'entreprise`; }, onDone)}>{busy ? "…" : "Enregistrer les instances autorisées"}</button>
        {!company && <span style={{ color: "#eab308", fontSize: 12 }}>aucune instance autorisée déclarée : aucun agent de cette entreprise ne peut être affecté ni démarrer</span>}
      </div>
    </div>
  );
}

/* ---------- Affectation d'un agent : affichée, suggérée (jamais appliquée), affectée / désaffectée / préparée explicitement ---------- */
function AgentAssignment({ s, companyId, company, instances, onDone }: { s: Sync; companyId: string; company: Company | null; instances: Instance[]; onDone: () => void }) {
  const assign = usePluginAction("assign-agent");
  const unassign = usePluginAction("unassign-agent");
  const prepare = usePluginAction("prepare-agent");
  const { busy, run } = useAct();
  const allowed = instances.filter((i) => company?.instances.includes(i.home));
  const [instanceHome, setInstanceHome] = React.useState<string>(s.suggestion?.instanceHome ?? allowed[0]?.home ?? "");
  const [profile, setProfile] = React.useState<string>(s.suggestion?.profile ?? "");
  const inst = allowed.find((i) => i.home === instanceHome);
  if (s.assignment) {
    const a = s.assignment;
    return (
      <div style={S.row}>
        <span style={S.code}>{s.instance}/{a.profile}</span>
        <span style={S.muted} title={a.instanceHome}>par {a.assignedBy} le {a.assignedAt.slice(0, 16).replace("T", " ")}</span>
        {s.error && <span style={{ color: "#ef4444", fontSize: 12 }}>{s.error}</span>}
        {s.error && /introuvable|interrompue|nettoy/.test(s.error) && <button style={S.btn} disabled={busy} onClick={() => void run(async () => { const r = (await prepare({ agentId: s.agentId, companyId })) as { created: string[]; warnings: string[] }; return `${s.agentName} : ${r.created.length} élément(s) créé(s)${r.warnings.length ? ` · ${r.warnings.length} avertissement(s)` : ""}`; }, onDone)}>{busy ? "…" : "Préparer l'agent"}</button>}
        <button style={S.btn} disabled={busy} onClick={() => void run(async () => { await unassign({ agentId: s.agentId, companyId }); return `${s.agentName} désaffecté`; }, onDone)}>{busy ? "…" : "Désaffecter"}</button>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={S.row}>
        <span style={{ color: "#ef4444" }}>non affecté</span>
        {s.suggestion && <span style={S.muted}>suggestion (par le {s.suggestion.by === "profile-name" ? "nom du profil" : "début de la description"}, jamais appliquée) : <span style={S.code}>{s.suggestion.instance}/{s.suggestion.profile}</span></span>}
        {!s.suggestion && <span style={S.muted}>aucun profil de ce nom dans les instances autorisées</span>}
      </div>
      {!allowed.length ? <span style={S.muted}>déclare d'abord les instances autorisées de l'entreprise</span> : (
        <div style={S.row}>
          <select style={S.select} value={instanceHome} onChange={(e) => { setInstanceHome(e.target.value); setProfile(""); }}>{allowed.map((i) => <option key={i.home} value={i.home}>{i.name}</option>)}</select>
          <input style={{ ...S.input, width: 160 }} list={`profiles-${s.agentId}`} placeholder="profil (existant, ou slug à préparer)" value={profile} onChange={(e) => setProfile(e.target.value)} />
          <datalist id={`profiles-${s.agentId}`}>{(inst?.profiles ?? []).map((p) => <option key={p.name} value={p.name} />)}</datalist>
          <button style={S.btn} disabled={busy || !instanceHome || !profile} onClick={() => void run(async () => { const r = (await assign({ agentId: s.agentId, companyId, instanceHome, profile })) as { toPrepare: boolean }; return `${s.agentName} affecté à ${inst?.name ?? instanceHome}/${profile}${r.toPrepare ? " (profil à préparer)" : ""}`; }, onDone)}>{busy ? "…" : "Affecter"}</button>
          <button style={S.btn} disabled={busy || !instanceHome} title="crée le profil (slug du nom) dans l'instance choisie, avec un .env vide, et affecte l'agent" onClick={() => void run(async () => { const r = (await prepare({ agentId: s.agentId, companyId, instanceHome })) as { created: string[]; warnings: string[] }; return `${s.agentName} : ${r.created.length} élément(s) créé(s)${r.warnings.length ? ` · ${r.warnings.length} avertissement(s)` : ""}`; }, onDone)}>{busy ? "…" : "Préparer et affecter"}</button>
        </div>
      )}
    </div>
  );
}

/* ---------- État en trois valeurs : installé (profil présent) / connecté / connecté et synchronisé ---------- */
function State({ state }: { state: AgentState }) {
  const color = state === "synced" ? "#22c55e" : state === "connected" ? "#eab308" : "inherit";
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

/* ---------- La vue « instances » ---------- */
export function HermesPage() {
  const ctx = useHostContext();
  const companyId = ctx.companyId;
  const { data, loading, error, refresh } = usePluginData<Data>("instances", { companyId });
  if (!companyId) return <div style={S.wrap}><span style={S.muted}>Choisis une entreprise.</span></div>;
  if (loading && !data) return <div style={S.wrap}><span style={S.muted}>Lecture des instances Hermes…</span></div>;
  if (error || !data) return <div style={S.wrap}><span style={{ color: "#ef4444" }}>Erreur : {error?.message ?? "pas de données"}</span></div>;
  const agentsOf = (p: Profile) => data.sync.filter((s) => s.home === p.home);
  const ws = data.workspace;
  const company = data.assignments?.company ?? null;
  // état d'une ligne : celui de ses agents ; sans agent, celui du profil seul (connecté ou installé)
  const stateOf = (p: Profile, agents: Sync[]): AgentState => {
    const states = agents.map((a) => data.states?.[a.agentId]).filter((x): x is AgentState => !!x);
    if (states.length) return states.includes("installed") ? "installed" : states.includes("connected") ? "connected" : "synced";
    return p.authStatus === "logged_in" ? "connected" : "installed";
  };
  return (
    <div style={S.wrap}>
      {data.assignments?.error && <div style={{ ...S.card, borderColor: "#ef4444", color: "#ef4444" }}>Table des affectations refusée : {data.assignments.error} — aucune écriture tant que {data.assignments.file} n'est pas réparé.</div>}
      <div style={S.card}>
        <div style={S.row}><strong style={{ fontSize: 16 }}>Dossiers communs</strong>{!ws && <span style={S.muted}>aucun dossier de travail déclaré (~/.config/hermes-control/workspace) : « Préparer l'agent » est indisponible</span>}</div>
        {ws && (
          <table style={{ ...S.table, marginTop: 8 }}><tbody>
            <tr><td style={S.td}>Dossier de travail</td><td style={{ ...S.td, ...S.code }}>{ws.root}</td></tr>
            <tr><td style={S.td}>Instances et profils Hermes</td><td style={{ ...S.td, ...S.code }}>{ws.profils}</td></tr>
            <tr><td style={S.td}>Skills communs (liés dans chaque profil)</td><td style={{ ...S.td, ...S.code }}>{ws.skills}</td></tr>
            <tr><td style={S.td}>Gabarits (SOUL, mémoire, fiche, instructions)</td><td style={{ ...S.td, ...S.code }}>{ws.modeles}</td></tr>
            <tr><td style={S.td}>Dossiers des agents</td><td style={{ ...S.td, ...S.code }}>{ws.agents}/&lt;agent&gt;/ (fiche, rapports, memoire, medias, journal)</td></tr>
            <tr><td style={S.td}>Table des affectations</td><td style={{ ...S.td, ...S.code }}>{data.assignments?.file}</td></tr>
          </tbody></table>
        )}
      </div>
      <CompanyInstances companyId={companyId} all={data.instances} company={company} onDone={refresh} />
      <div style={S.card}>
        <div style={S.row}><strong style={{ fontSize: 16 }}>Agents Hermes de l'entreprise</strong><span style={S.muted}>l'affectation est explicite : ouvrir cette page n'affecte, ne prépare et n'écrit rien ; une suggestion par le nom n'est jamais appliquée</span></div>
        {!data.sync.length && <div style={{ ...S.muted, marginTop: 8 }}>aucun agent Hermes dans cette entreprise</div>}
        {data.sync.length > 0 && (
          <table style={{ ...S.table, marginTop: 10 }}>
            <thead><tr><th style={S.th}>Agent</th><th style={S.th}>Affectation</th><th style={S.th}>État</th><th style={S.th}>Synchro</th></tr></thead>
            <tbody>
              {data.sync.map((s) => (
                <tr key={s.agentId}>
                  <td style={S.td}><strong>{s.agentName}</strong>{s.prepared?.length ? " ✦" : ""}<div style={{ ...S.muted, ...S.code }}>{s.agentId}</div></td>
                  <td style={S.td}><AgentAssignment s={s} companyId={companyId} company={company} instances={data.instances} onDone={refresh} /></td>
                  <td style={S.td}>{data.states?.[s.agentId] ? <State state={data.states[s.agentId]!} /> : <span style={S.muted}>—</span>}</td>
                  <td style={S.td}>{s.assignment ? (s.error ? <span style={{ color: "#ef4444", fontSize: 12 }}>aucune écriture</span> : s.changed.length ? <span style={S.muted}>écrit : {s.changed.join(", ")}</span> : <span style={S.muted}>à jour</span>) : <span style={S.muted}>aucune écriture</span>}{s.cwd && <div style={{ ...S.muted, ...S.code }}>dossier : {s.cwd}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!data.instances.length && <div style={S.card}>Aucune instance Hermes trouvée.</div>}
      {data.instances.map((inst) => (
        <div key={inst.home} style={S.card}>
          <div style={S.row}>
            <strong style={{ fontSize: 16 }}>{inst.name}</strong>
            <span style={{ ...S.muted, ...S.code }}>{inst.home}</span>
            {company?.instances.includes(inst.home) ? <span style={{ color: "#22c55e", fontSize: 12 }}>autorisée pour cette entreprise</span> : <span style={S.muted}>non autorisée pour cette entreprise</span>}
            {inst.dashboardUrl && <a href={inst.dashboardUrl} target="_blank" rel="noreferrer">tableau de bord ↗</a>}
            <span style={{ marginLeft: "auto", color: inst.errors24h ? "#ef4444" : "inherit" }}>{inst.errors24h} erreur(s) 24 h</span>
          </div>
          <table style={{ ...S.table, marginTop: 10 }}>
            <thead><tr><th style={S.th}>Profil</th><th style={S.th}>Description</th><th style={S.th}>Modèle</th><th style={S.th}>État</th><th style={S.th}>Connexion</th><th style={S.th}>Validations</th><th style={S.th}>Terminal</th><th style={S.th}>Agents Paperclip affectés</th><th style={S.th}>Telegram</th></tr></thead>
            <tbody>
              {inst.profiles.map((p) => {
                const agents = agentsOf(p);
                return (
                  <tr key={p.name}>
                    <td style={S.td}><strong>{p.name}</strong></td>
                    <td style={S.td}>{p.description ?? <span style={S.muted}>—</span>}</td>
                    <td style={S.td}><span style={S.code}>{p.provider ?? "?"}/{p.model ?? "?"}</span></td>
                    <td style={S.td}><State state={stateOf(p, agents)} /></td>
                    <td style={S.td}><Dot auth={p.authStatus} /></td>
                    <td style={S.td}><span style={{ color: p.approvalsMode === "off" ? "#ef4444" : "inherit" }}>{p.approvalsMode ?? "—"}</span></td>
                    <td style={S.td}><span style={{ color: p.terminalBackend === "local" ? "#eab308" : "inherit" }}>{p.terminalBackend ?? "—"}</span></td>
                    <td style={S.td}>{agents.length ? agents.map((a) => <span key={a.agentId} title={`${a.error ? a.error : a.changed.length ? `écrit : ${a.changed.join(", ")}` : "synchro à jour"}${a.cwd ? ` · dossier : ${a.cwd}` : ""}`} style={{ color: a.error ? "#ef4444" : "inherit" }}>{a.agentName}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), []) : <span style={S.muted}>aucun</span>}</td>
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
    </div>
  );
}
