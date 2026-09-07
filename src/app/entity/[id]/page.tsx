import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntity } from "@/lib/queries";
import { strengthLabel } from "@/lib/graph/scoring";
import { Avatar, Card, Meter, TypeBadge, TypeDot, formatDate, relativeMonths } from "@/components/ui";
import { PathTrail } from "@/components/PathTrail";
import { IconSpark } from "@/components/Icons";
import type { OutreachHook } from "@/lib/types";

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getEntity(id).catch(() => null);
  if (!detail) notFound();

  const { entity, aliases, relationships, evidence, meetings, pathsFromSelf, isSelf } = detail;
  const attrs = entity.attributes ?? {};
  const hooks = (attrs.hooks ?? []) as OutreachHook[];

  // Awareness edges are shown, but never mixed in with real relationships.
  const real = relationships.filter((r) => r.type !== "mentioned");
  const awareness = relationships.filter((r) => r.type === "mentioned");

  return (
    <div className="page">
      <header className="pageHead">
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <Avatar name={entity.canonical_name} type={entity.entity_type} large />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row row--wrap" style={{ gap: 8 }}>
              <h1>{entity.canonical_name}</h1>
              {isSelf ? <span className="badge badge--brand">You</span> : null}
              {entity.status === "needs_review" ? <span className="badge badge--warn">Needs review</span> : null}
            </div>
            <p className="pageSub">
              {[attrs.title, attrs.org, attrs.location].filter(Boolean).join(" · ") ||
                attrs.description ||
                [attrs.org_type?.replace(/_/g, " "), (attrs.sector ?? []).join(", ")]
                  .filter(Boolean)
                  .join(" · ") ||
                (entity.entity_type === "person"
                  ? "No role captured yet."
                  : "Named in your meetings; no description captured yet.")}
            </p>
            <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
              <TypeBadge type={entity.entity_type} />
              <span className="badge">{entity.degree} connections</span>
              <span className="badge">
                {entity.source_count} meeting{entity.source_count === 1 ? "" : "s"}
              </span>
              <span className="badge">Last seen {relativeMonths(entity.last_seen)}</span>
              {aliases.length > 1 ? <span className="badge">Also: {aliases.filter((a) => a !== entity.canonical_name).slice(0, 3).join(", ")}</span> : null}
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid--split">
        <div className="stack stack--lg">
          {pathsFromSelf.length > 0 ? (
            <Card title="How to reach them">
              <div className="stack stack--lg">
                {pathsFromSelf.map((p, i) => (
                  <div key={i} className="stack stack--sm">
                    {i > 0 ? <span className="xsmall muted">Alternative route</span> : null}
                    <PathTrail path={p} />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title={`Relationships (${real.length})`}>
            {real.length === 0 ? (
              <p className="dim small">No typed relationships yet — only mentions.</p>
            ) : (
              <div className="stack stack--lg">
                {real.map((r) => (
                  <div key={r.edgeId} className="stack stack--sm">
                    <div className="row row--wrap" style={{ gap: 8 }}>
                      <TypeDot type={r.otherType} />
                      <Link href={`/entity/${r.otherId}`} style={{ fontWeight: 560 }}>
                        {r.otherName}
                      </Link>
                      <span className="badge">
                        {r.typeLabel}
                        {r.ended ? " (former)" : ""}
                      </span>
                      {r.otherTitle ? <span className="xsmall muted">{r.otherTitle}</span> : null}
                      <span className="spacer" />
                      <Meter value={r.strength} label={strengthLabel(r.strength)} brand />
                    </div>
                    {r.context ? <p className="quote">{r.context}</p> : null}
                    <div className="row row--wrap xsmall muted" style={{ gap: 12 }}>
                      <span>warmth {Math.round(r.warmth * 100)}%</span>
                      <span>
                        {r.evidenceCount} claim{r.evidenceCount === 1 ? "" : "s"} across {r.sourceDiversity}{" "}
                        meeting{r.sourceDiversity === 1 ? "" : "s"}
                      </span>
                      <span>last {relativeMonths(r.lastSeen)}</span>
                      {r.scoreTerms ? (
                        <span title="The terms behind the strength score">
                          base {r.scoreTerms.base?.toFixed(2)} · volume {r.scoreTerms.volume?.toFixed(2)} ·
                          recency {r.scoreTerms.recency?.toFixed(2)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={`Evidence (${evidence.length})`}>
            {evidence.length === 0 ? (
              <p className="dim small">No quoted claims.</p>
            ) : (
              <div className="stack">
                {evidence.map((e, i) => (
                  <div key={i} className="stack stack--sm">
                    <p className="quote">&ldquo;{e.quote}&rdquo;</p>
                    <div className="row row--wrap xsmall muted" style={{ gap: 10 }}>
                      <span className="badge">{e.predicate.replace(/_/g, " ")}</span>
                      <span className="badge">{e.explicitness}</span>
                      <Link href={`/meetings/${e.source_id}`}>{e.source_title}</Link>
                      <span>{formatDate(e.occurred_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack stack--lg">
          {hooks.length > 0 ? (
            <Card title="Outreach hooks">
              <div className="stack">
                <p className="small dim">What would make an email to them land.</p>
                {hooks.map((h, i) => (
                  <div key={i} className="stack stack--sm">
                    <div className="row" style={{ gap: 7 }}>
                      <IconSpark size={13} />
                      <span className="badge">{h.kind}</span>
                      <span className="xsmall muted">{formatDate(h.observed_at)}</span>
                    </div>
                    <p className="small">{h.hook}</p>
                    {h.quote ? <p className="quote xsmall">&ldquo;{h.quote}&rdquo;</p> : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {entity.dossier ? (
            <Card title="Dossier">
              <p className="small dim" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                {entity.dossier}
              </p>
              <p className="xsmall muted" style={{ marginTop: 10 }}>
                Regenerated on every projection. This is the text that gets embedded and compared
                during entity resolution.
              </p>
            </Card>
          ) : null}

          <Card title="Attributes">
            <div className="stack stack--sm small">
              <AttrRow label="Type" value={entity.entity_type} />
              <AttrRow label="Title" value={attrs.title} />
              <AttrRow label="Organisation" value={attrs.org} />
              <AttrRow label="Email" value={attrs.email} />
              <AttrRow label="Location" value={attrs.location} />
              <AttrRow label="Seniority" value={attrs.seniority} />
              <AttrRow label="Stage" value={attrs.stage} />
              <AttrRow label="Sector" value={(attrs.sector ?? []).join(", ")} />
              <AttrRow label="Expertise" value={(attrs.expertise ?? []).join(", ")} />
              <AttrRow label="Interests" value={(attrs.interests ?? []).join(", ")} />
              <AttrRow label="First seen" value={formatDate(entity.first_seen)} />
              <AttrRow label="Brokerage" value={`${Math.round(entity.brokerage * 100)}%`} />
            </div>
          </Card>

          <Card title={`Meetings (${meetings.length})`}>
            <div className="stack stack--sm">
              {meetings.map((m) => (
                <Link key={m.id} href={`/meetings/${m.id}`} className="stack stack--sm">
                  <span className="small" style={{ fontWeight: 545 }}>
                    {m.title}
                  </span>
                  <span className="xsmall muted">{formatDate(m.occurred_at)}</span>
                </Link>
              ))}
            </div>
          </Card>

          {awareness.length > 0 ? (
            <Card title={`Awareness (${awareness.length})`}>
              <p className="small dim" style={{ marginBottom: 8 }}>
                People who have talked about them. Awareness is not a relationship, so it is kept
                separate and weighted low when routing.
              </p>
              <div className="row row--wrap" style={{ gap: 6 }}>
                {awareness.map((r) => (
                  <Link key={r.edgeId} href={`/entity/${r.otherId}`} className="badge">
                    {r.otherName}
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AttrRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="row row--between" style={{ gap: 12, alignItems: "baseline" }}>
      <span className="xsmall muted" style={{ flex: "none" }}>
        {label}
      </span>
      <span style={{ textAlign: "right", minWidth: 0 }}>{value}</span>
    </div>
  );
}
