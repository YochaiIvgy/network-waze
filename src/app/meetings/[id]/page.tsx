import Link from "next/link";
import { notFound } from "next/navigation";
import { getMeeting } from "@/lib/queries";
import { RELATIONSHIP_META, type RelationshipType } from "@/lib/types";
import { Avatar, Card, TypeDot, formatDate } from "@/components/ui";
import { IconWarn } from "@/components/Icons";

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getMeeting(id).catch(() => null);
  if (!data) notFound();

  const { source, run, participants, relationships, hooks, unresolved } = data;
  const attendees = participants.filter((p) => p.role_in_source === "attendee" || p.role_in_source === "speaker");
  const discussed = participants.filter((p) => !attendees.includes(p));

  return (
    <div className="page">
      <header className="pageHead">
        <h1>{source.title}</h1>
        <p className="pageSub">
          {formatDate(source.occurred_at)}
          {source.token_estimate ? ` · ~${source.token_estimate.toLocaleString()} tokens` : ""}
          {run ? ` · extractor ${run.extractor_version} · ${run.model}` : ""}
        </p>
      </header>

      <div className="grid grid--split">
        <div className="stack stack--lg">
          <Card title="Transcript" tight>
            <div className="transcript">{renderBody(source.body)}</div>
          </Card>

          <Card title={`Relationships extracted (${relationships.length})`}>
            {relationships.length === 0 ? (
              <p className="dim small">No relationships were asserted in this meeting.</p>
            ) : (
              <div className="stack stack--lg">
                {relationships.map((r, i) => (
                  <div key={i} className="stack stack--sm">
                    <div className="row row--wrap" style={{ gap: 7 }}>
                      <Link href={`/entity/${r.subject_id}`} style={{ fontWeight: 555 }}>
                        {r.subject}
                      </Link>
                      <span className="badge">
                        {RELATIONSHIP_META[r.predicate as RelationshipType]?.label ?? r.predicate}
                        {r.polarity === -1 ? " — ended" : ""}
                      </span>
                      <Link href={`/entity/${r.object_id}`} style={{ fontWeight: 555 }}>
                        {r.object}
                      </Link>
                      <span className="spacer" />
                      <span className="badge">{r.explicitness}</span>
                    </div>
                    {typeof r.value?.context === "string" ? (
                      <p className="small dim">{r.value.context as string}</p>
                    ) : null}
                    {r.quote ? <p className="quote">&ldquo;{r.quote}&rdquo;</p> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="stack stack--lg">
          <Card title={`Attendees (${attendees.length})`}>
            <div className="stack stack--sm">
              {attendees.map((p) => (
                <Link key={p.entity_id} href={`/entity/${p.entity_id}`} className="row" style={{ gap: 10 }}>
                  <Avatar name={p.canonical_name} type={p.entity_type} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 550, display: "block", fontSize: 13 }}>{p.canonical_name}</span>
                    <span className="xsmall muted truncate" style={{ display: "block" }}>
                      {p.attributes?.title ?? p.attributes?.org ?? "—"}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </Card>

          {discussed.length > 0 ? (
            <Card title={`Also discussed (${discussed.length})`}>
              <div className="row row--wrap" style={{ gap: 6 }}>
                {discussed.map((p) => (
                  <Link key={`${p.entity_id}-${p.surface_form}`} href={`/entity/${p.entity_id}`} className="badge">
                    <TypeDot type={p.entity_type} />
                    {p.canonical_name}
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}

          {hooks.length > 0 ? (
            <Card title={`Hooks & commitments (${hooks.length})`}>
              <div className="stack">
                {hooks.map((h, i) => (
                  <div key={i} className="stack stack--sm">
                    <div className="row" style={{ gap: 7 }}>
                      <Link href={`/entity/${h.entity_id}`} style={{ fontWeight: 550, fontSize: 13 }}>
                        {h.canonical_name}
                      </Link>
                      <span className="badge">{h.predicate.replace(/_/g, " ")}</span>
                    </div>
                    <p className="small dim">{hookText(h.value)}</p>
                    {h.quote ? <p className="quote xsmall">&ldquo;{h.quote}&rdquo;</p> : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {unresolved.length > 0 ? (
            <div className="banner banner--warn">
              <IconWarn size={15} />
              <span>
                <strong>{unresolved.length} unresolved mention{unresolved.length === 1 ? "" : "s"}</strong> —{" "}
                {unresolved.map((u) => `"${u.surface_form}"`).join(", ")}. Not enough to identify
                anyone, so no node was created. They stay in the ledger and resolve automatically
                once a later meeting corroborates them.
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Hook/commitment claims store their payload under different keys by predicate. */
function hookText(value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  return String(v.hook ?? v.what ?? v.action ?? "");
}

/** Region tags come from the normaliser; highlight them so the structure reads. */
function renderBody(body: string) {
  return body.split("\n").map((line, i) => {
    const tag = /^\[(ATTENDEES|SUMMARY|NOTES|TRANSCRIPT)\]$/.exec(line.trim());
    if (tag) {
      return (
        <div key={i} style={{ margin: i === 0 ? "0 0 6px" : "18px 0 6px" }}>
          <span className="regionTag">{tag[1]}</span>
        </div>
      );
    }
    return <div key={i}>{line || " "}</div>;
  });
}
