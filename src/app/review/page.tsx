import { getWorkspace, query } from "@/lib/db";
import { listReviews } from "@/lib/queries";
import { ReviewQueue, type ReviewRow } from "@/components/ReviewQueue";
import { Card } from "@/components/ui";
import { Setup } from "@/components/Setup";

export default async function ReviewPage() {
  let rows: ReviewRow[];
  let deferred: Array<{ surface_form: string; title: string; disambiguation_context: string | null }>;
  try {
    const ws = await getWorkspace();
    rows = (await listReviews()) as unknown as ReviewRow[];
    deferred = await query(
      `SELECT m.surface_form, s.title, m.disambiguation_context
       FROM mentions m
       JOIN sources s ON s.id = m.source_id
       LEFT JOIN mention_links ml ON ml.mention_id = m.id
       WHERE s.workspace_id = $1 AND ml.mention_id IS NULL
       ORDER BY s.occurred_at DESC`,
      [ws.id],
    );
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  return (
    <div className="page">
      <header className="pageHead">
        <h1>Review queue</h1>
        <p className="pageSub">
          Identity decisions the resolver would not make on its own. A merge is easy to make and
          hard to undo cleanly, so anything between the thresholds waits here instead of being
          guessed.
        </p>
      </header>

      <div className="stack stack--lg">
        <ReviewQueue rows={rows} />

        {deferred.length > 0 ? (
          <Card title={`Deferred mentions (${deferred.length})`}>
            <p className="small dim" style={{ marginBottom: 12 }}>
              First names with nothing to pin them to. These deliberately did not become nodes — a
              global &ldquo;Jen&rdquo; would collide with every other Jen you ever meet. They stay in
              the ledger and resolve automatically once a later meeting gives them a surname, an
              employer, or a shared contact.
            </p>
            <div className="stack">
              {deferred.map((d, i) => (
                <div key={i} className="stack stack--sm">
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 555 }}>{d.surface_form}</span>
                    <span className="badge">{d.title}</span>
                  </div>
                  {d.disambiguation_context ? <p className="quote xsmall">{d.disambiguation_context}</p> : null}
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
