import Link from "next/link";
import { getOverview } from "@/lib/queries";
import { isEmbedded } from "@/lib/db";
import { strengthLabel } from "@/lib/graph/scoring";
import { Avatar, Card, EmptyState, Meter, StatTile, formatDate, relativeMonths } from "@/components/ui";
import { IconArrow, IconSpark, IconWarn } from "@/components/Icons";
import { Setup } from "@/components/Setup";

export default async function OverviewPage() {
  let data;
  try {
    data = await getOverview();
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  const { stats, connectors, recentMeetings, liveHooks, strongestEdges } = data;

  if (stats.meetings === 0) {
    return (
      <div className="page">
        <EmptyState title="No meetings yet">
          Run <code className="mono">npm run db:seed</code> for the demo network, or paste a Granola
          transcript to start building your own.
        </EmptyState>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Link href="/ingest" className="btn btn--primary">
            Add a transcript
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="pageHead">
        <h1>Your network</h1>
        <p className="pageSub">
          Built from {stats.meetings} meeting{stats.meetings === 1 ? "" : "s"} and {stats.claims.toLocaleString()}{" "}
          quoted claims. Everything below is derived — and rebuildable — from those transcripts.
        </p>
        {isEmbedded() ? (
          <p className="xsmall muted" style={{ marginTop: 6 }}>
            Running on the embedded Postgres at <code className="mono">./.waze-data</code>. Set{" "}
            <code className="mono">DATABASE_URL</code> to point at a real server.
          </p>
        ) : null}
      </header>

      <div className="grid grid--stats" style={{ marginBottom: 18 }}>
        <StatTile label="People" value={stats.people} hint={`${stats.reachable} reachable in 3 hops`} href="/people" />
        <StatTile label="Organisations" value={stats.organizations} hint="companies, funds and LPs" href="/people" />
        <StatTile label="Connections" value={stats.edges} hint="typed, evidenced edges" href="/graph" />
        <StatTile label="Meetings" value={stats.meetings} hint="sources in the ledger" href="/meetings" />
        <StatTile
          label="Needs a decision"
          value={stats.reviews + stats.deferred}
          hint={`${stats.reviews} to review · ${stats.deferred} deferred`}
          href="/review"
        />
      </div>

      <div className="grid grid--split">
        <div className="stack stack--lg">
          <Card
            title="Who to call"
            action={
              <Link href="/search" className="btn btn--sm btn--ghost">
                Ask a question <IconArrow size={12} />
              </Link>
            }
          >
            {connectors.length === 0 ? (
              <p className="dim small">
                No self node is set, so there is nothing to route from. Re-run <code className="mono">npm run db:seed</code>{" "}
                or set <code className="mono">workspaces.self_entity_id</code>.
              </p>
            ) : (
              <div className="stack">
                <p className="small dim" style={{ marginBottom: 2 }}>
                  Ranked by how much of the network opens through them, weighted by how likely each
                  introduction is to land.
                </p>
                {connectors.map((c, i) => (
                  <Link key={c.id} href={`/entity/${c.id}`} className="row" style={{ gap: 12 }}>
                    <span className="muted tnum xsmall" style={{ width: 14 }}>
                      {i + 1}
                    </span>
                    <Avatar name={c.name} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 560, display: "block" }}>{c.name}</span>
                      <span className="xsmall muted truncate" style={{ display: "block" }}>
                        opens {c.unlocks} {c.unlocks === 1 ? "route" : "routes"} · {c.targets.slice(0, 3).join(", ")}
                      </span>
                    </span>
                    <Meter value={Math.min(1, c.score / Math.max(...connectors.map((x) => x.score)))} label="" brand />
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card title="Strongest ties in the graph">
            <div className="stack">
              {strongestEdges.map((e) => (
                <div key={e.id} className="stack stack--sm">
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    <Link href={`/entity/${e.aId}`} style={{ fontWeight: 560 }}>
                      {e.a}
                    </Link>
                    <span className="badge">{e.typeLabel}</span>
                    <Link href={`/entity/${e.bId}`} style={{ fontWeight: 560 }}>
                      {e.b}
                    </Link>
                    <span className="spacer" />
                    <Meter value={e.strength} label={strengthLabel(e.strength)} brand />
                  </div>
                  {e.context ? <p className="quote">{e.context}</p> : null}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack stack--lg">
          <Card title="Live hooks">
            {liveHooks.length === 0 ? (
              <p className="dim small">No time-sensitive hooks captured yet.</p>
            ) : (
              <div className="stack">
                <p className="small dim">
                  Time-sensitive details worth acting on before they go stale.
                </p>
                {liveHooks.map((h, i) => (
                  <div key={`${h.entityId}-${i}`} className="stack stack--sm">
                    <div className="row" style={{ gap: 7 }}>
                      <IconSpark size={13} />
                      <Link href={`/entity/${h.entityId}`} style={{ fontWeight: 560, fontSize: 13 }}>
                        {h.entityName}
                      </Link>
                      <span className="badge">{h.hook.kind}</span>
                    </div>
                    <p className="small dim">{h.hook.hook}</p>
                    {h.hook.quote ? <p className="quote xsmall">&ldquo;{h.hook.quote}&rdquo;</p> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Recent meetings"
            action={
              <Link href="/meetings" className="btn btn--sm btn--ghost">
                All
              </Link>
            }
          >
            <div className="stack">
              {recentMeetings.map((m) => (
                <Link key={m.id} href={`/meetings/${m.id}`} className="row" style={{ gap: 10 }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="truncate" style={{ fontWeight: 550, display: "block", fontSize: 13 }}>
                      {m.title}
                    </span>
                    <span className="xsmall muted">
                      {formatDate(m.occurred_at)} · {relativeMonths(m.occurred_at)} · {m.people} entities
                    </span>
                  </span>
                  <IconArrow size={13} />
                </Link>
              ))}
            </div>
          </Card>

          {stats.deferred > 0 ? (
            <div className="banner banner--warn">
              <IconWarn size={15} />
              <span>
                <strong>{stats.deferred}</strong> mention{stats.deferred === 1 ? "" : "s"} left unresolved
                on purpose — first names with nothing to pin them to. They stay in the ledger and
                resolve automatically once a later meeting corroborates them.
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
