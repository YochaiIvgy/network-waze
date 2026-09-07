"use client";

import Link from "next/link";
import { useState } from "react";
import type { SearchResponse } from "@/lib/search/answer";
import { Avatar, Card, Meter, TypeDot } from "./ui";
import { PathTrail } from "./PathTrail";
import { IconSearch, IconSpark } from "./Icons";

const EXAMPLES = [
  "I want to find LPs for the fund",
  "I need Lockheed Martin access",
  "Who do I know in defense procurement?",
  "How am I connected to Janet Reyes?",
  "Which family offices have I met?",
];

export function SearchView({ hasKey, selfName }: { hasKey: boolean; selfName: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (text: string) => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed");
      setResult(json as SearchResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack stack--lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <div className="row" style={{ gap: 8 }}>
          <div className="searchField" style={{ flex: 1 }}>
            <IconSearch size={15} />
            <input
              className="input"
              style={{ padding: "11px 12px 11px 33px", fontSize: 15 }}
              placeholder="What do you need from your network?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <button className="btn btn--primary" disabled={loading || !query.trim()} style={{ padding: "10px 16px" }}>
            {loading ? "Searching…" : "Ask"}
          </button>
        </div>
      </form>

      <div className="row row--wrap" style={{ gap: 6 }}>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            className="chip"
            onClick={() => {
              setQuery(ex);
              run(ex);
            }}
          >
            {ex}
          </button>
        ))}
      </div>

      {!hasKey ? (
        <div className="banner">
          <span>
            No <code className="mono">ANTHROPIC_API_KEY</code> set, so search runs in offline mode:
            keyword planning and local embeddings, and no written answer. Retrieval, routing and
            ranking all still work.
          </span>
        </div>
      ) : null}

      {error ? <div className="banner banner--warn">{error}</div> : null}

      {loading ? (
        <div className="stack">
          <div className="skeleton" style={{ height: 92 }} />
          <div className="skeleton" style={{ height: 180 }} />
        </div>
      ) : null}

      {result ? <Results result={result} selfName={selfName} /> : null}
    </div>
  );
}

function Results({ result, selfName }: { result: SearchResponse; selfName: string }) {
  const [showPlan, setShowPlan] = useState(false);

  return (
    <div className="stack stack--lg">
      {result.answer ? (
        <div className="answer">
          <div className="row" style={{ gap: 7, marginBottom: 10 }}>
            <IconSpark size={14} />
            <span className="xsmall" style={{ fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Answer
            </span>
          </div>
          {result.answer.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      ) : null}

      <div className="grid grid--split">
        <div className="stack stack--lg">
          <Card title={`Routes from you (${result.paths.length})`}>
            {result.paths.length === 0 ? (
              <p className="dim small">
                No route found under these constraints. Either the target is not connected to you in
                the graph yet, or the warm-only filter removed every link.
              </p>
            ) : (
              <div className="stack stack--lg">
                {result.paths.map((p, i) => (
                  <PathTrail key={`${p.targetId}-${i}`} path={p} selfLabel={selfName} />
                ))}
              </div>
            )}
          </Card>

          {result.connectors.length > 0 ? (
            <Card title="Best people to ask">
              <div className="stack">
                <p className="small dim">
                  Ranked by how many of these targets each one unlocks, weighted by likelihood.
                </p>
                {result.connectors.map((c) => (
                  <Link key={c.id} href={`/entity/${c.id}`} className="row" style={{ gap: 10 }}>
                    <Avatar name={c.name} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 555, display: "block" }}>{c.name}</span>
                      <span className="xsmall muted truncate" style={{ display: "block" }}>
                        unlocks {c.targets.slice(0, 3).join(", ")}
                        {c.targets.length > 3 ? ` +${c.targets.length - 3}` : ""}
                      </span>
                    </span>
                    <span className="badge">{c.unlocks}</span>
                  </Link>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="stack stack--lg">
          <Card title={`Candidates (${result.candidates.length})`}>
            <div className="stack">
              {result.candidates.slice(0, 10).map((c) => (
                <Link key={c.id} href={`/entity/${c.id}`} className="stack stack--sm">
                  <span className="row" style={{ gap: 8 }}>
                    <TypeDot type={c.type} />
                    <span style={{ fontWeight: 550, fontSize: 13 }}>{c.name}</span>
                    <span className="spacer" />
                    <Meter value={Math.min(1, c.score)} label="" />
                  </span>
                  {c.title || c.org ? (
                    <span className="xsmall muted">{[c.title, c.org].filter(Boolean).join(" · ")}</span>
                  ) : null}
                  {c.reasons.length ? <span className="xsmall dim">{c.reasons[0]}</span> : null}
                  {c.hooks[0] ? <span className="quote xsmall">{c.hooks[0].hook}</span> : null}
                </Link>
              ))}
            </div>
          </Card>

          <Card
            title="Query plan"
            action={
              <button className="btn btn--sm btn--ghost" onClick={() => setShowPlan((v) => !v)}>
                {showPlan ? "Hide JSON" : "Show JSON"}
              </button>
            }
          >
            <div className="stack stack--sm small">
              <p className="dim">{result.plan.interpretation}</p>
              <div className="row row--wrap" style={{ gap: 6 }}>
                <span className="badge">{result.plan.intent.replace(/_/g, " ")}</span>
                <span className="badge">planner: {result.planner}</span>
                <span className="badge">≤ {result.plan.constraints.max_hops} hops</span>
                <span className="badge">min strength {result.plan.constraints.min_strength}</span>
                {result.plan.constraints.exclude_weak_awareness ? (
                  <span className="badge badge--brand">warm routes only</span>
                ) : null}
                <span className="badge">{result.latencyMs} ms</span>
              </div>
              {showPlan ? (
                <pre
                  className="mono"
                  style={{
                    background: "var(--surface-2)",
                    padding: 12,
                    borderRadius: "var(--r-sm)",
                    overflowX: "auto",
                    margin: 0,
                    fontSize: 11.5,
                  }}
                >
                  {JSON.stringify(result.plan, null, 2)}
                </pre>
              ) : null}
              <p className="xsmall muted">
                The plan is data, not a hidden prompt: a bad answer is traceable to a bad plan or a
                thin graph, never to both at once.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
