"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Meter } from "./ui";

export interface ReviewRow {
  id: string;
  score: number;
  features: Record<string, number>;
  mention_surface: string;
  mention_context: string | null;
  source_title: string;
  candidate_id: string;
  candidate_name: string;
  candidate_title: string | null;
  candidate_dossier: string | null;
}

const FEATURE_LABEL: Record<string, string> = {
  name: "Name similarity",
  email: "Email match",
  org: "Same organisation",
  context: "Context similarity",
  neighbors: "Shared contacts",
  title: "Title overlap",
  first_name_only: "First-name-only penalty",
};

/**
 * The band between auto-merge and auto-reject. Every row shows the exact feature
 * breakdown that produced the score, because "the model thought so" is not a
 * reason to merge two people's identities.
 */
export function ReviewQueue({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const decide = async (reviewId: string, verdict: "same" | "different") => {
    setPending(reviewId);
    setError(null);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId, verdict }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setDone((prev) => new Set(prev).add(reviewId));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const open = rows.filter((r) => !done.has(r.id));

  if (open.length === 0) {
    return (
      <EmptyState title="Nothing to review">
        Every mention either matched confidently or was rejected confidently. Ambiguous ones land
        here rather than being guessed.
      </EmptyState>
    );
  }

  return (
    <div className="stack stack--lg">
      {error ? <div className="banner banner--warn">{error}</div> : null}
      {open.map((r) => (
        <Card key={r.id} title={`Is "${r.mention_surface}" the same person as ${r.candidate_name}?`}>
          <div className="grid grid--2">
            <div className="stack stack--sm">
              <span className="xsmall muted">New mention</span>
              <span style={{ fontWeight: 570 }}>{r.mention_surface}</span>
              <span className="xsmall muted">from {r.source_title}</span>
              {r.mention_context ? <p className="quote">{r.mention_context}</p> : null}
            </div>
            <div className="stack stack--sm">
              <span className="xsmall muted">Existing entity</span>
              <Link href={`/entity/${r.candidate_id}`} style={{ fontWeight: 570 }}>
                {r.candidate_name}
              </Link>
              {r.candidate_title ? <span className="xsmall muted">{r.candidate_title}</span> : null}
              {r.candidate_dossier ? <p className="quote">{r.candidate_dossier.slice(0, 260)}</p> : null}
            </div>
          </div>

          <div className="stack stack--sm" style={{ marginTop: 16 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className="xsmall muted">Score</span>
              <Meter value={r.score} label={r.score.toFixed(2)} brand />
              <span className="xsmall muted">auto-merge at 0.82 · auto-reject at 0.45</span>
            </div>
            <div className="row row--wrap" style={{ gap: 6 }}>
              {Object.entries(r.features).map(([k, v]) => (
                <span key={k} className="badge" title={FEATURE_LABEL[k] ?? k}>
                  {FEATURE_LABEL[k] ?? k}: {typeof v === "number" ? v.toFixed(2) : String(v)}
                </span>
              ))}
            </div>
          </div>

          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            <button
              className="btn btn--primary"
              disabled={pending === r.id}
              onClick={() => decide(r.id, "same")}
            >
              Same person — merge
            </button>
            <button className="btn" disabled={pending === r.id} onClick={() => decide(r.id, "different")}>
              Different people
            </button>
            <span className="spacer" />
            <span className="xsmall muted">Merges are recorded and reversible.</span>
          </div>
        </Card>
      ))}
    </div>
  );
}
