// Interface du plugin Hermes Control (React fourni par Paperclip) : un lien « Hermes » et une seule vue, « instances ».
import React from "react";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

type Auth = "logged_in" | "logged_out" | "unknown";
interface Profile { name: string; home: string; description: string | null; model: string | null; provider: string | null; authStatus: Auth; approvalsMode: string | null; terminalBackend: string | null }
interface Instance { name: string; home: string; dashboardUrl: string | null; profiles: Profile[]; errors24h: number; lastError: string | null }
interface Sync { agentId: string; agentName: string; instance: string | null; profile: string | null; home: string | null; want: { provider: string | null; model: string | null; thinking: string | null }; cwd: string | null; changed: string[]; error: string | null; at: string }

const S = {
  wrap: { padding: 16, display: "grid", gap: 16, fontSize: 14 } as React.CSSProperties,
  card: { border: "1px solid var(--border, #334)", borderRadius: 10, padding: 14 } as React.CSSProperties,
  muted: { opacity: 0.7, fontSize: 12 } as React.CSSProperties,
  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: { textAlign: "left" as const, padding: "6px 8px", opacity: 0.7, fontWeight: 600, borderBottom: "1px solid var(--border, #334)" },
  td: { padding: "6px 8px", borderBottom: "1px solid var(--border, #223)", verticalAlign: "top" as const },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12 },
};

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
  const { data, loading, error } = usePluginData<{ instances: Instance[]; sync: Sync[] }>("instances", { companyId });
  if (!companyId) return <div style={S.wrap}><span style={S.muted}>Choisis une entreprise.</span></div>;
  if (loading && !data) return <div style={S.wrap}><span style={S.muted}>Lecture des instances Hermes…</span></div>;
  if (error || !data) return <div style={S.wrap}><span style={{ color: "#ef4444" }}>Erreur : {error?.message ?? "pas de données"}</span></div>;
  if (!data.instances.length) return <div style={S.wrap}><div style={S.card}>Aucune instance Hermes trouvée.</div></div>;
  const agentsOf = (inst: string, profile: string) => data.sync.filter((s) => s.instance === inst && s.profile === profile);
  return (
    <div style={S.wrap}>
      {data.instances.map((inst) => (
        <div key={inst.home} style={S.card}>
          <div style={S.row}>
            <strong style={{ fontSize: 16 }}>{inst.name}</strong>
            <span style={{ ...S.muted, ...S.code }}>{inst.home}</span>
            {inst.dashboardUrl && <a href={inst.dashboardUrl} target="_blank" rel="noreferrer">tableau de bord ↗</a>}
            <span style={{ marginLeft: "auto", color: inst.errors24h ? "#ef4444" : "inherit" }}>{inst.errors24h} erreur(s) 24 h</span>
          </div>
          <table style={{ ...S.table, marginTop: 10 }}>
            <thead><tr><th style={S.th}>Profil</th><th style={S.th}>Description</th><th style={S.th}>Modèle</th><th style={S.th}>Connexion</th><th style={S.th}>Validations</th><th style={S.th}>Terminal</th><th style={S.th}>Agents Paperclip</th></tr></thead>
            <tbody>
              {inst.profiles.map((p) => {
                const agents = agentsOf(inst.name, p.name);
                return (
                  <tr key={p.name}>
                    <td style={S.td}><strong>{p.name}</strong></td>
                    <td style={S.td}>{p.description ?? <span style={S.muted}>—</span>}</td>
                    <td style={S.td}><span style={S.code}>{p.provider ?? "?"}/{p.model ?? "?"}</span></td>
                    <td style={S.td}><Dot auth={p.authStatus} /></td>
                    <td style={S.td}><span style={{ color: p.approvalsMode === "off" ? "#ef4444" : "inherit" }}>{p.approvalsMode ?? "—"}</span></td>
                    <td style={S.td}><span style={{ color: p.terminalBackend === "local" ? "#eab308" : "inherit" }}>{p.terminalBackend ?? "—"}</span></td>
                    <td style={S.td}>{agents.length ? agents.map((a) => <span key={a.agentId} title={a.error ? a.error : a.changed.length ? `écrit : ${a.changed.join(", ")}` : "synchro à jour"} style={{ color: a.error ? "#ef4444" : "inherit" }}>{a.agentName}</span>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), []) : <span style={S.muted}>aucun</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {inst.lastError && <div style={{ ...S.muted, ...S.code, marginTop: 8 }}>dernière erreur : {inst.lastError}</div>}
        </div>
      ))}
      {data.sync.some((s) => !s.instance) && (
        <div style={{ ...S.card, borderColor: "#ef4444" }}>
          <strong style={{ color: "#ef4444" }}>Agents Hermes sans profil de ce nom : {data.sync.filter((s) => !s.instance).map((s) => s.agentName).join(", ")}</strong>
        </div>
      )}
    </div>
  );
}
