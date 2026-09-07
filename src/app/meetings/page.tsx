import Link from "next/link";
import { listMeetings } from "@/lib/queries";
import { EmptyState, formatDate, relativeMonths } from "@/components/ui";
import { IconArrow } from "@/components/Icons";
import { Setup } from "@/components/Setup";

export default async function MeetingsPage() {
  let rows;
  try {
    rows = await listMeetings();
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  return (
    <div className="page">
      <header className="pageHead">
        <h1>Meetings</h1>
        <p className="pageSub">
          The source layer. Transcripts are immutable and content-hashed, so re-ingesting the same
          Granola export is a no-op — and every claim in the graph points back to one of these.
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="No sources yet" action={<Link href="/ingest" className="btn btn--primary">Add a transcript</Link>}>
          Paste a Granola note, or point the CLI at an export folder with{" "}
          <code className="mono">npm run ingest -- ./exports</code>.
        </EmptyState>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Date</th>
                  <th className="tnum">Entities</th>
                  <th className="tnum">Relationships</th>
                  <th className="tnum">Claims</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/meetings/${m.id}`} style={{ fontWeight: 550 }}>
                        {m.title}
                      </Link>
                    </td>
                    <td className="small dim">
                      {formatDate(m.occurred_at)}
                      <span className="xsmall muted"> · {relativeMonths(m.occurred_at)}</span>
                    </td>
                    <td className="tnum small dim">{m.people}</td>
                    <td className="tnum small dim">{m.relationships}</td>
                    <td className="tnum small dim">{m.claims}</td>
                    <td style={{ width: 32 }}>
                      <Link href={`/meetings/${m.id}`} className="btn btn--ghost btn--icon" aria-label="Open">
                        <IconArrow size={13} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
