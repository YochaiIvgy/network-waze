import { Logo } from "./Logo";

/** Shown when the database is unreachable or unmigrated. */
export function Setup({ error }: { error: string }) {
  const steps: Array<[string, string]> = [
    ["Start Postgres", "docker compose up -d"],
    ["Point the app at it", "cp .env.example .env"],
    ["Create the schema", "npm run db:push"],
    ["Load the demo network", "npm run db:seed"],
  ];

  return (
    <div className="page" style={{ maxWidth: 660 }}>
      <div className="row" style={{ gap: 12, marginBottom: 18 }}>
        <Logo size={40} />
        <div>
          <h1>Set up the graph</h1>
          <p className="pageSub">Four commands. No API key needed for the demo data.</p>
        </div>
      </div>

      <section className="card card--pad" style={{ marginBottom: 14 }}>
        <div className="stack">
          {steps.map(([label, cmd], i) => (
            <div key={cmd} className="row" style={{ gap: 12, alignItems: "flex-start" }}>
              <span
                className="avatar"
                style={{ background: "var(--surface-3)", color: "var(--ink-2)", width: 22, height: 22, borderRadius: 6, fontSize: 11 }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 550 }}>{label}</span>
                <code className="mono muted">{cmd}</code>
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="banner">
        <span>
          <strong>What went wrong:</strong> <span className="mono">{error}</span>
          <br />
          Any Postgres 14+ works — Supabase, Neon or a local instance. Set{" "}
          <code className="mono">DATABASE_URL</code> and re-run{" "}
          <code className="mono">npm run db:push</code>.
        </span>
      </div>
    </div>
  );
}
