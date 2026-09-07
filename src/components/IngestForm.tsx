"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "./ui";
import { IconUpload } from "./Icons";

interface IngestResult {
  sourceId: string;
  alreadyIngested: boolean;
  title: string;
  counts: { people: number; organizations: number; relationships: number; claims: number };
  entitiesCreated: number;
  entitiesMatched: number;
  reviewsQueued: number;
  tokenEstimate: number;
  attendees: number;
}

export function IngestForm({ hasKey }: { hasKey: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, title }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Ingestion failed");
      setResult(json as IngestResult);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div className="grid grid--split">
      <div className="stack stack--lg">
        <Card title="Paste a Granola note">
          <div className="stack">
            <input
              className="input"
              placeholder="Meeting title (optional — parsed from the note if present)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="textarea"
              placeholder={
                "Paste the Granola export — JSON, Markdown or plain text.\n\n" +
                "The normaliser recognises attendee, summary and transcript sections and tags them,\n" +
                "because the extractor should trust the attendee list for spelling and the transcript\n" +
                "for relationship nuance."
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onDrop={async (e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) await onFile(file);
              }}
              onDragOver={(e) => e.preventDefault()}
            />
            <div className="row" style={{ gap: 8 }}>
              <label className="btn btn--sm">
                <IconUpload size={13} />
                Choose file
                <input
                  type="file"
                  accept=".json,.md,.txt"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) await onFile(file);
                  }}
                />
              </label>
              <span className="xsmall muted">
                {text ? `${text.length.toLocaleString()} characters` : "or drag a file onto the box"}
              </span>
              <span className="spacer" />
              <button className="btn btn--primary" onClick={submit} disabled={busy || !hasKey || text.trim().length < 40}>
                {busy ? "Extracting…" : "Extract & merge"}
              </button>
            </div>
          </div>
        </Card>

        {error ? <div className="banner banner--warn">{error}</div> : null}

        {busy ? (
          <Card title="Running">
            <div className="stack stack--sm small dim">
              <p>Extracting entities, relationships and hooks…</p>
              <p>Then: resolve against existing entities, then re-project the graph.</p>
              <div className="skeleton" style={{ height: 8, marginTop: 6 }} />
            </div>
          </Card>
        ) : null}

        {result ? (
          <Card title={result.alreadyIngested ? "Already in the graph" : "Ingested"}>
            {result.alreadyIngested ? (
              <p className="small dim">
                This transcript is already in the ledger — sources are keyed by content hash, so
                re-ingesting the same note is a no-op.
              </p>
            ) : (
              <div className="stack">
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="badge">{result.counts.people} people</span>
                  <span className="badge">{result.counts.organizations} orgs</span>
                  <span className="badge">{result.counts.relationships} relationships</span>
                  <span className="badge">{result.counts.claims} claims</span>
                </div>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <span className="badge badge--good">{result.entitiesCreated} new entities</span>
                  <span className="badge badge--brand">{result.entitiesMatched} merged into existing</span>
                  {result.reviewsQueued ? (
                    <span className="badge badge--warn">{result.reviewsQueued} queued for review</span>
                  ) : null}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Link href={`/meetings/${result.sourceId}`} className="btn btn--sm">
                    Open meeting
                  </Link>
                  <Link href="/graph" className="btn btn--sm">
                    See the graph
                  </Link>
                </div>
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <div className="stack stack--lg">
        {!hasKey ? (
          <div className="banner banner--warn">
            <span>
              <code className="mono">ANTHROPIC_API_KEY</code> is not set, so extraction is disabled.
              Add it to <code className="mono">.env</code> and restart. Browsing the seeded graph
              works without it.
            </span>
          </div>
        ) : null}

        <Card title="What happens next">
          <ol className="stack small dim" style={{ paddingLeft: 18, margin: 0 }}>
            <li>
              <strong>Normalise</strong> — attendee, summary and transcript regions get tagged so the
              extractor can weigh them differently.
            </li>
            <li>
              <strong>Extract</strong> — one structured call returns people, orgs, relationships,
              intro opportunities and outreach hooks, each with a verbatim quote.
            </li>
            <li>
              <strong>Append</strong> — mentions and claims are written to the ledger. Nothing is
              ever overwritten.
            </li>
            <li>
              <strong>Resolve</strong> — each mention is matched against existing entities by name,
              email, employer, context and shared contacts. Ambiguous pairs go to the review queue
              rather than being guessed.
            </li>
            <li>
              <strong>Project</strong> — edges, strengths, dossiers and metrics are rebuilt from
              scratch, so the graph can never drift from the transcripts.
            </li>
          </ol>
        </Card>

        <Card title="Bulk import">
          <p className="small dim">
            For a whole Granola export directory, use the CLI — it is idempotent, so you can re-run
            it as the folder grows:
          </p>
          <pre
            className="mono"
            style={{ background: "var(--surface-2)", padding: 12, borderRadius: "var(--r-sm)", marginTop: 10, overflowX: "auto" }}
          >
            npm run ingest -- ./granola-export
          </pre>
        </Card>
      </div>
    </div>
  );
}
