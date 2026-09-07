"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Network, Users, Building2, Route, AudioLines, Search, Plus, ArrowUpRight, ArrowRight,
  ChevronDown, Sun, Moon, SlidersHorizontal, X, Sparkles, Check, Link2, Settings2,
  GitMerge, CircleHelp, Gauge, Quote as QuoteIcon,
} from "lucide-react";
import { NetworkCanvas } from "@/components/NetworkCanvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ViewEdge, ViewEntity, ViewGraph } from "@/lib/view-model";

const NAV = {
  Network,
  People: Users,
  Organizations: Building2,
  "Introduction paths": Route,
  "Ask your network": Sparkles,
  Meetings: AudioLines,
  "Entity review": GitMerge,
} as const;

type ViewName = keyof typeof NAV;

const EMPTY: ViewGraph = {
  entities: [], edges: [], meetings: [], reviews: [], selfEntityId: null,
  stats: { people: 0, organizations: 0, edges: 0, claims: 0, meetings: 0, reviews: 0, deferred: 0 },
};

interface PathHop {
  from: string; fromName: string; to: string; toName: string;
  probability: number; edgeId: string; kind: string; kindLabel: string;
  strength: number; warmth: number; context: string; ended: boolean;
}
interface RankedPath {
  targetId: string; targetName: string; probability: number; cost: number; label: string;
  firstConnector: { id: string; name: string } | null; hops: PathHop[];
}
interface Connector {
  id: string; name: string; unlocks: number; score: number; targets: string[];
}
interface RemoteMeeting { id: string; title: string; date?: string; transcript?: string | null; error?: string }

interface SearchAnswer {
  query: string;
  planner: "llm" | "heuristic";
  plan: { intent?: string; [k: string]: unknown };
  answer: string | null;
  latencyMs: number;
  candidates: Array<{
    id: string; name: string; type: string; title: string | null; org: string | null;
    score: number; reasons: string[]; hooks: Array<{ hook: string; kind: string }>;
  }>;
  paths: Array<{
    targetId: string; targetName: string; probability: number; relevance: number; label: string;
    hops: Array<{
      fromName: string; toName: string; toId: string; typeLabel: string;
      strength: number; warmth: number; probability: number;
      context: string | null; evidenceCount: number;
    }>;
  }>;
  connectors: Connector[];
}

const initials = (s: string) => s.split(" ").map((x) => x[0]).slice(0, 2).join("");
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function Home() {
  const [g, setG] = useState<ViewGraph>(EMPTY);
  const [view, setView] = useState<ViewName>("Network");
  const [selected, setSelected] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("All entities");
  const [dark, setDark] = useState(false);
  const [modal, setModal] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [connected, setConnected] = useState(false);
  const [canExtract, setCanExtract] = useState(true);
  const [remote, setRemote] = useState<RemoteMeeting[]>([]);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState("");
  const [extracting, setExtracting] = useState("");
  const [meetingErrors, setMeetingErrors] = useState<Record<string, string>>({});

  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");

  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [paths, setPaths] = useState<RankedPath[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pathBusy, setPathBusy] = useState(false);
  const pathToken = useRef(0);

  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [asking, setAsking] = useState(false);

  const entity = g.entities.find((e) => e.id === selected);
  const links = g.edges.filter((e) => e.source === selected || e.target === selected)
    .sort((a, b) => b.strength - a.strength);
  const visible = g.entities.filter(
    (e) =>
      (filter === "All entities" || e.type === (filter === "People" ? "person" : "organization")) &&
      `${e.name} ${e.role} ${e.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/graph");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Saved network is unavailable.");
      setG(d.graph);
      setConnected(d.connected);
      setCanExtract(d.canExtract);
      const first = d.graph.selfEntityId || d.graph.entities[0]?.id || "";
      setSelected((c) => (d.graph.entities.some((e: ViewEntity) => e.id === c) ? c : first));
      setSource((c) => (d.graph.entities.some((e: ViewEntity) => e.id === c) ? c : first));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const isDark = localStorage.getItem("waze-theme") === "dark";
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    void load();
    const p = new URLSearchParams(location.search);
    // Views are deep-linkable, so a particular screen can be shared or bookmarked.
    const requested = p.get("view");
    if (requested && requested in NAV) setView(requested as ViewName);
    if (p.has("connected")) {
      setView("Meetings");
      setNotice("Granola connected. Extract a meeting to add it to your network.");
    }
    if (p.has("error")) setNotice(p.get("error") || "Connection failed.");
  }, [load]);

  const refreshMeetings = useCallback(async () => {
    setListing(true);
    setListError("");
    try {
      const d = await action("/api/granola", { action: "list" });
      setRemote(d.meetings);
      await load();
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setListing(false);
    }
  }, [load]);

  useEffect(() => {
    if (loading) return;
    if (connected) void refreshMeetings();
    else setRemote([]);
  }, [connected, refreshMeetings, loading]);

  // Path search runs on the server: it is Dijkstra over the whole graph, and the
  // token guard keeps a slow request from overwriting a newer selection.
  useEffect(() => {
    if (!source || view !== "Introduction paths") return;
    const token = ++pathToken.current;
    setPathBusy(true);
    action("/api/paths", { source, target: target || undefined })
      .then((d) => {
        if (token !== pathToken.current) return;
        setPaths(d.paths ?? []);
        setConnectors(d.connectors ?? []);
      })
      .catch((e) => {
        if (token === pathToken.current) setNotice((e as Error).message);
      })
      .finally(() => {
        if (token === pathToken.current) setPathBusy(false);
      });
  }, [source, target, view, g]);

  async function extractMeeting(m: RemoteMeeting) {
    setExtracting(m.id);
    setMeetingErrors((p) => ({ ...p, [m.id]: "" }));
    setNotice("");
    try {
      const d = await action("/api/granola", {
        action: "extract", meetingId: m.id, title: m.title, date: m.date,
      });
      await load();
      setNotice(
        d.alreadyIngested
          ? "That transcript is already in your network — nothing was duplicated."
          : `Extracted ${d.counts.relationships} relationships and ${d.counts.claims} quoted claims. ` +
            `${d.entitiesCreated} new entities, ${d.entitiesMatched} matched to existing ones` +
            `${d.reviewsQueued ? `, ${d.reviewsQueued} sent to review` : ""}.`,
      );
      if (!d.alreadyIngested) setView("Network");
    } catch (e) {
      setMeetingErrors((p) => ({ ...p, [m.id]: (e as Error).message }));
    } finally {
      setExtracting("");
    }
  }

  function theme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("waze-theme", next ? "dark" : "light");
  }

  function nav(v: ViewName) {
    setView(v);
    setQ("");
    setFilter("All entities");
    const url = new URL(location.href);
    url.searchParams.set("view", v);
    url.searchParams.delete("connected");
    url.searchParams.delete("error");
    history.replaceState(null, "", url);
  }

  async function action(url: string, body: unknown) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Something went wrong. Please retry.");
    return d;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stored = new Map(g.meetings.filter((m) => m.externalId).map((m) => [m.externalId!, m]));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/46c.png" alt="" />
          <span>network intelligence</span>
        </div>
        <div className="workspace">
          <span className="workspace-icon">NW</span>
          <div>
            <strong>Your workspace</strong>
            <small>Private network</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(Object.entries(NAV) as Array<[ViewName, typeof Network]>).map(([name, Icon]) => (
            <button key={name} className={`nav-item ${view === name ? "active" : ""}`} onClick={() => nav(name)}>
              <Icon size={18} />
              <span>{name}</span>
              {name === "Entity review" && g.reviews.length > 0 && <b>{g.reviews.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="source-card">
            <AudioLines className="granola-mark" size={25} />
            <strong>
              Your conversations,
              <br />
              connected.
            </strong>
            <p>Turn meeting context into your next warm introduction.</p>
            <button onClick={() => (connected ? nav("Meetings") : setModal("settings"))}>
              {connected ? "Browse Granola" : "Connect Granola"}
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings2 size={18} />
            Settings &amp; integrations
          </button>
          <div className="profile">
            <span className="avatar you">Y</span>
            <div>
              <strong>Your workspace</strong>
              <small>Personal account</small>
            </div>
            <button className="icon-button" onClick={theme} aria-label="Switch color theme">
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Network size={17} />
            <span>Workspace</span>
            <span>/</span>
            <strong>{view}</strong>
          </div>
          <div className="top-actions">
            <i className="green-dot" />
            Private workspace
            <button className="icon-button" aria-label="Help" onClick={() => setModal("settings")}>
              <CircleHelp size={18} />
            </button>
          </div>
        </header>

        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">RELATIONSHIPS, WITH EVIDENCE</div>
              <h1>{view === "Network" ? "Your network. Connected." : view}</h1>
              <p>
                {view === "Network"
                  ? "Every conversation adds a connection. See where yours can take you."
                  : view === "Introduction paths"
                    ? "The most likely way in, ranked by the probability the whole chain works."
                    : view === "Ask your network"
                      ? "Plan, retrieve, route, answer — with every claim traced back to a meeting."
                      : view === "Entity review"
                        ? "Resolve uncertain identities using the context behind each mention."
                        : "One place for your relationships and the conversations behind them."}
              </p>
            </div>
            <Button
              className="primary-button"
              onClick={() => {
                if (connected && view !== "Meetings") nav("Meetings");
                else setModal("import");
              }}
            >
              <Plus size={17} />
              {view === "Meetings" ? "Paste transcript" : connected ? "Browse meetings" : "Import meeting"}
            </Button>
          </div>

          {notice && (
            <div role="status" className="notice">
              {notice}
              <button onClick={() => setNotice("")} aria-label="Dismiss">
                <X size={15} />
              </button>
            </div>
          )}

          {/* Without a "you" node the graph has no origin, so introduction paths
              have nowhere to start and search returns matches with no routes. */}
          {!loading && !g.selfEntityId && g.stats.people > 0 && (
            <div role="status" className="notice">
              Pick yourself in the network so introduction paths know where to start — open your own
              entity and choose <strong>This is me</strong>.
            </div>
          )}

          <div className="stats">
            {([
              [Users, "People", g.stats.people, "Across your conversations"],
              [Building2, "Organizations", g.stats.organizations, "Companies, funds & communities"],
              [Link2, "Connections", g.stats.edges, `From ${g.stats.claims.toLocaleString()} quoted claims`],
              [AudioLines, "Meetings", g.stats.meetings, "Immutable, re-extractable sources"],
            ] as const).map(([Icon, label, value, sub]) => (
              <div className="stat" key={label}>
                <div className="stat-label">
                  <Icon size={16} />
                  {label}
                  <ArrowUpRight size={14} />
                </div>
                <div className="stat-value">
                  {value}
                  <span>
                    {label === "Connections" ? "Evidence-backed" : label === "Meetings" ? "Source-linked" : "Resolved"}
                  </span>
                </div>
                <small>{sub}</small>
              </div>
            ))}
          </div>

          <div className="data-status">
            <span>
              <i className="green-dot" />
              {loading ? "Loading your workspace…" : "Your network"}
              <span className="muted">
                {g.stats.claims.toLocaleString()} claims · {g.stats.reviews} to review
                {g.stats.deferred ? ` · ${g.stats.deferred} mentions held back` : ""}
              </span>
            </span>
            <button onClick={() => nav("Meetings")}>
              {connected ? "View Granola meetings" : g.stats.meetings ? "View meetings" : "Import your first meeting"}
              <ArrowRight size={13} />
            </button>
          </div>

          {["Network", "People", "Organizations"].includes(view) && (
            <div className="network-layout">
              <section className="network-panel">
                <div className="panel-toolbar">
                  <div className="view-tabs">
                    <button className={view === "Network" ? "selected" : ""} onClick={() => nav("Network")}>
                      <Network size={15} />
                      Graph view
                    </button>
                    <button className={view !== "Network" ? "selected" : ""} onClick={() => nav("People")}>
                      <Users size={15} />
                      Directory
                    </button>
                  </div>
                  <span className="entity-count">{visible.length} entities</span>
                </div>

                <div className="graph-filters">
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      aria-label="Search your network"
                      placeholder="Search people, organizations, tags…"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </label>
                  <label className="filter-select">
                    <SlidersHorizontal size={14} />
                    <select aria-label="Filter entity type" value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <option>All entities</option>
                      <option>People</option>
                      <option>Organizations</option>
                    </select>
                  </label>
                </div>

                {view === "Network" ? (
                  <NetworkCanvas
                    graph={g}
                    visible={visible}
                    selected={selected}
                    onSelect={setSelected}
                    empty={
                      <div className="empty-overlay">
                        <strong>
                          {loading
                            ? "Loading your network…"
                            : g.entities.length
                              ? "No matching entities."
                              : "No extracted connections yet"}
                        </strong>
                        {!loading && !g.entities.length && (
                          <>
                            <p>
                              {connected
                                ? "Your Granola meetings are in Meetings. Extract one to build your network."
                                : "Connect Granola or paste a transcript to get started."}
                            </p>
                            <Button variant="outline" onClick={() => (connected ? nav("Meetings") : setModal("import"))}>
                              {connected ? "Go to Meetings" : "Import a meeting"}
                              <ArrowRight size={14} />
                            </Button>
                          </>
                        )}
                      </div>
                    }
                  />
                ) : (
                  <div className="directory">
                    {visible
                      .filter((e) => e.type === (view === "People" ? "person" : "organization"))
                      .map((e) => (
                        <button
                          key={e.id}
                          className={`directory-row ${selected === e.id ? "chosen" : ""}`}
                          onClick={() => setSelected(e.id)}
                        >
                          <span className={`avatar ${e.type}`}>{initials(e.name)}</span>
                          <div>
                            <strong>{e.name}</strong>
                            <small>{e.role}</small>
                          </div>
                          <span>{e.tags[0]}</span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    {!visible.length && <p className="empty">No matching entities.</p>}
                  </div>
                )}
              </section>

              <aside className="detail-panel">
                {entity ? (
                  <>
                    <div className="detail-caption">
                      ENTITY INTELLIGENCE
                      <span>
                        <i className="green-dot" />
                        {entity.resolution === "pending" ? "Needs review" : "Canonical"}
                      </span>
                    </div>
                    <div className={`avatar big ${entity.type}`}>{initials(entity.name)}</div>
                    <h2>{entity.name}</h2>
                    <p className="role">{entity.role}</p>
                    {entity.type === "person" && (
                      <button
                        type="button"
                        className={`self-toggle ${entity.isSelf ? "on" : ""}`}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await action("/api/workspace", {
                              selfEntityId: entity.isSelf ? null : entity.id,
                            });
                            await load();
                          })
                        }
                      >
                        {entity.isSelf ? "This is you — paths start here" : "This is me"}
                      </button>
                    )}
                    <div className="tags">
                      {entity.tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </div>

                    <div className="detail-metrics">
                      <div>
                        <strong>{entity.degree || links.length}</strong>
                        <span>connections</span>
                      </div>
                      <div>
                        <strong>{entity.sourceCount}</strong>
                        <span>meetings</span>
                      </div>
                      <div>
                        <strong>{entity.mentionCount}</strong>
                        <span>mentions</span>
                      </div>
                      <div>
                        <strong>{Math.round(entity.brokerage * 100)}</strong>
                        <span>broker score</span>
                      </div>
                    </div>

                    <div className="section-label">
                      <Sparkles size={14} />
                      DOSSIER
                    </div>
                    <p className="context-copy">
                      {dossierForDisplay(entity.context) ||
                        "No dossier yet — it is generated when this entity is next projected."}
                    </p>

                    {entity.hooks.length > 0 && (
                      <>
                        <div className="section-label">
                          <QuoteIcon size={14} />
                          OUTREACH HOOKS
                        </div>
                        <div className="connection-list">
                          {entity.hooks.slice(0, 3).map((h, i) => (
                            <div key={i} className="hook-row">
                              <strong>{h.hook}</strong>
                              <small>{h.kind}</small>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    <div className="section-label">
                      <Link2 size={14} />
                      STRONGEST CONNECTIONS
                    </div>
                    <div className="connection-list">
                      {links.slice(0, 4).map((l) => {
                        const other = g.entities.find((e) => e.id === (l.source === selected ? l.target : l.source));
                        return (
                          <button key={l.id} onClick={() => other && setSelected(other.id)}>
                            <span className={`avatar mini ${other?.type}`}>{initials(other?.name || "")}</span>
                            <div>
                              <strong>{other?.name}</strong>
                              <small>
                                {l.kindLabel} · {pct(l.strength)} strength
                                {l.willingness === "yes" ? " · intro offered" : ""}
                              </small>
                            </div>
                            <ArrowUpRight size={14} />
                          </button>
                        );
                      })}
                      {!links.length && <p className="muted">No connections recorded yet.</p>}
                    </div>

                    {bestQuote(links) && (
                      <div className="quote">
                        <span>
                          <AudioLines size={13} />
                          FROM YOUR CONVERSATIONS
                        </span>
                        <p>“{bestQuote(links)!.quote}”</p>
                        <button onClick={() => nav("Meetings")}>
                          {bestQuote(links)!.meetingTitle}
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    )}

                    <Button
                      variant="outline"
                      className="path-button"
                      onClick={() => {
                        setTarget(entity.id);
                        nav("Introduction paths");
                      }}
                    >
                      <Route size={16} />
                      Find introduction paths
                      <ArrowRight size={15} />
                    </Button>
                  </>
                ) : (
                  <p className="empty">Select an entity to see its context.</p>
                )}
              </aside>
            </div>
          )}

          {view === "Introduction paths" && (
            <section className="content-card">
              <div className="path-search">
                <Route />
                <div>
                  <h2>Where do you want to go?</h2>
                  <p>
                    Shortest path over cost = −ln(p), so the route shown is the most likely chain to actually
                    work — not merely the fewest hops.
                  </p>
                </div>
              </div>

              <div className="path-inputs">
                <label>
                  From
                  <select value={source} onChange={(e) => setSource(e.target.value)}>
                    {g.entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                <ArrowRight size={20} />
                <label>
                  To
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Anyone — rank my best connectors</option>
                    {g.entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="muted">
                Each hop&apos;s probability combines relationship type, strength, warmth and recency. A path is a
                ranked hypothesis, never a guarantee of an introduction.
              </p>

              {pathBusy && <p role="status" className="draft-status">Searching the graph…</p>}

              {!target && connectors.length > 0 && (
                <>
                  <div className="section-label" style={{ marginTop: 22 }}>
                    <Gauge size={14} />
                    WHO TO CALL FIRST
                  </div>
                  <div className="connection-list">
                    {connectors.map((c) => (
                      <button key={c.id} onClick={() => setSelected(c.id)}>
                        <span className="avatar mini">{initials(c.name)}</span>
                        <div>
                          <strong>{c.name}</strong>
                          <small>
                            opens {c.unlocks} {c.unlocks === 1 ? "person" : "people"} · {c.targets.slice(0, 3).join(", ")}
                          </small>
                        </div>
                        <ArrowUpRight size={14} />
                      </button>
                    ))}
                  </div>
                </>
              )}

              {paths.map((p, i) => (
                <div className="path-card" key={`${p.targetId}-${i}`}>
                  <div className="path-card-top">
                    <span>{i === 0 ? "MOST LIKELY PATH" : `ALTERNATIVE ${i}`}</span>
                    <span>
                      {p.hops.length} {p.hops.length === 1 ? "step" : "steps"} · {pct(p.probability)} likely · {p.label}
                    </span>
                  </div>

                  <div className="path-chain">
                    {[p.hops[0]?.from, ...p.hops.map((h) => h.to)].filter(Boolean).map((id, j) => (
                      <div key={`${id}-${j}`}>
                        {j > 0 && <ArrowRight size={17} />}
                        <span className="avatar mini">{initials(g.entities.find((e) => e.id === id)?.name || "")}</span>
                        <strong>{g.entities.find((e) => e.id === id)?.name}</strong>
                      </div>
                    ))}
                  </div>

                  {p.hops.map((h, j) => {
                    const edge = g.edges.find((e) => e.id === h.edgeId);
                    return (
                      <div className="path-evidence" key={`${h.edgeId}-${j}`}>
                        <Check size={15} />
                        <div>
                          <strong>
                            {h.fromName} → {h.toName} · {h.kindLabel}
                            {h.ended ? " (ended)" : ""}
                          </strong>
                          <p>{h.context || "No context card was generated for this tie."}</p>
                          {edge?.evidence[0]?.quote && <p>“{edge.evidence[0].quote}”</p>}
                          <small>
                            {pct(h.probability)} this hop · strength {pct(h.strength)} · warmth {pct(h.warmth)}
                            {edge?.evidence[0] ? ` · ${edge.evidence[0].meetingTitle}` : ""}
                          </small>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

              {!pathBusy && !paths.length && (
                <div className="empty">
                  No supported path found. Choose another target, or add more conversations.
                </div>
              )}
            </section>
          )}

          {view === "Ask your network" && (
            <section className="content-card">
              <div className="path-search">
                <Sparkles />
                <div>
                  <h2>Ask in your own words</h2>
                  <p>
                    Your question is turned into a retrieval plan, matched against entity dossiers and
                    structured filters, routed through the graph, then answered with citations.
                  </p>
                </div>
              </div>

              <form
                className="ask-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!ask.trim() || asking) return;
                  setAsking(true);
                  setNotice("");
                  action("/api/search", { query: ask.trim() })
                    .then(setAnswer)
                    .catch((err) => setNotice((err as Error).message))
                    .finally(() => setAsking(false));
                }}
              >
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Ask your network"
                    placeholder="e.g. Who can get me into Lockheed Martin?"
                    value={ask}
                    onChange={(e) => setAsk(e.target.value)}
                  />
                </label>
                <Button className="primary-button" disabled={asking || !ask.trim() || !canExtract}>
                  {asking ? "Thinking…" : "Ask"}
                  <ArrowRight size={15} />
                </Button>
              </form>

              {!canExtract && (
                <p className="muted">ANTHROPIC_API_KEY is not set, so planning and answering are unavailable.</p>
              )}

              {answer && (
                <>
                  {answer.answer && (
                    <div className="ask-answer">
                      <div className="section-label">
                        <Sparkles size={14} />
                        ANSWER
                      </div>
                      <p>{answer.answer}</p>
                      <small className="muted">
                        {answer.planner === "llm" ? "LLM-planned" : "Heuristic plan"} ·{" "}
                        {answer.candidates.length} candidates · {answer.latencyMs}ms
                      </small>
                    </div>
                  )}

                  {answer.paths.map((p, i) => (
                    <div className="path-card" key={`${p.targetId}-${i}`}>
                      <div className="path-card-top">
                        <span>{p.targetName.toUpperCase()}</span>
                        <span>
                          {pct(p.probability)} likely · {p.label} · {pct(p.relevance)} match
                        </span>
                      </div>
                      <div className="path-chain">
                        {[p.hops[0]?.fromName, ...p.hops.map((h) => h.toName)].filter(Boolean).map((name, j) => (
                          <div key={`${name}-${j}`}>
                            {j > 0 && <ArrowRight size={17} />}
                            <span className="avatar mini">{initials(name as string)}</span>
                            <strong>{name}</strong>
                          </div>
                        ))}
                      </div>
                      {p.hops.map((h, j) => (
                        <div className="path-evidence" key={j}>
                          <Check size={15} />
                          <div>
                            <strong>
                              {h.fromName} → {h.toName} · {h.typeLabel}
                            </strong>
                            <p>{h.context || "No context card was generated for this tie."}</p>
                            <small>
                              {pct(h.probability)} this hop · strength {pct(h.strength)} · warmth {pct(h.warmth)} ·{" "}
                              {h.evidenceCount} {h.evidenceCount === 1 ? "claim" : "claims"}
                            </small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}

                  {answer.candidates.length > 0 && (
                    <>
                      <div className="section-label" style={{ marginTop: 22 }}>
                        <Users size={14} />
                        WHO MATCHED
                      </div>
                      <div className="connection-list">
                        {answer.candidates.slice(0, 6).map((c) => (
                          <button key={c.id} onClick={() => { setSelected(c.id); nav("Network"); }}>
                            <span className={`avatar mini ${c.type === "person" ? "person" : "organization"}`}>
                              {initials(c.name)}
                            </span>
                            <div>
                              <strong>{c.name}</strong>
                              <small>
                                {[c.title, c.org].filter(Boolean).join(" at ") || c.type} ·{" "}
                                {c.reasons.slice(0, 2).join(", ")}
                              </small>
                            </div>
                            <ArrowUpRight size={14} />
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {!answer.answer && !answer.paths.length && (
                    <div className="empty">
                      <h3>No supported answer</h3>
                      <p>Nothing in the graph answers that yet. Add more conversations, or ask it differently.</p>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {view === "Meetings" && (
            <section className="content-card">
              <div className="section-title">
                <div>
                  <h2>Conversation library</h2>
                  <p className="muted">
                    Transcripts are fetched once from Granola and stored here. Read any meeting before you extract —
                    extraction runs on our own model with a strict schema, so every claim arrives with a verbatim quote.
                  </p>
                </div>
                {connected ? (
                  <Button variant="outline" disabled={listing} onClick={() => void refreshMeetings()}>
                    <AudioLines size={16} />
                    {listing ? "Loading from Granola…" : "Refresh Granola"}
                  </Button>
                ) : (
                  <a className="connect-link" href="/api/granola/connect">
                    Connect Granola
                    <ArrowUpRight size={16} />
                  </a>
                )}
              </div>

              <div className="meeting-stages">
                <span>{remote.length} available from Granola</span>
                <ArrowRight size={14} />
                <span>{g.meetings.filter((m) => m.status === "extracted").length} extracted</span>
                <ArrowRight size={14} />
                <span>{g.stats.claims.toLocaleString()} claims in the ledger</span>
              </div>

              {!canExtract && (
                <div role="alert" className="notice">
                  ANTHROPIC_API_KEY is not set, so extraction is unavailable. Browsing the graph still works.
                </div>
              )}
              {listError && (
                <div role="alert" className="notice">
                  {listError}
                  <Button variant="outline" onClick={() => void refreshMeetings()}>
                    Retry
                  </Button>
                </div>
              )}

              {remote.map((m) => {
                const local = stored.get(m.id);
                const extracted = local?.status === "extracted";
                const text = m.transcript || local?.transcript;
                const error = meetingErrors[m.id] || m.error;
                return (
                  <article className="library-meeting" key={m.id}>
                    <div className="library-row">
                      <span className="meeting-icon">
                        <AudioLines size={21} />
                      </span>
                      <div className="library-title">
                        <strong>{m.title}</strong>
                        <small>{m.date || "Date unavailable"} · Granola</small>
                      </div>
                      <span className="meeting-status">
                        {extracting === m.id
                          ? "Extracting…"
                          : extracted
                            ? `In your network · ${local?.claimCount ?? 0} claims`
                            : text
                              ? "Transcript saved"
                              : "Ready to extract"}
                      </span>
                      {!extracted && (
                        <Button disabled={!!extracting || busy || !canExtract} onClick={() => void extractMeeting(m)}>
                          <Sparkles size={15} />
                          {extracting === m.id ? "Extracting…" : "Extract connections"}
                        </Button>
                      )}
                    </div>
                    {extracting === m.id && (
                      <p role="status" className="extraction-progress">
                        Reading the whole transcript in one pass. This takes a minute on a long meeting.
                      </p>
                    )}
                    {error && (
                      <p role="alert" className="notice">
                        {error}
                      </p>
                    )}
                    <details className="meeting">
                      <summary>
                        <span>View transcript</span>
                        <ChevronDown size={16} />
                      </summary>
                      <div className="meeting-body">
                        {text ? (
                          <p>{text}</p>
                        ) : (
                          <p className="muted">
                            {listing
                              ? "Fetching transcript from Granola…"
                              : "No transcript stored for this meeting."}
                          </p>
                        )}
                      </div>
                    </details>
                  </article>
                );
              })}

              {g.meetings.some((m) => m.status === "extracted" || !m.externalId) && (
                <>
                  <div className="section-label" style={{ marginTop: 26 }}>
                    <Check size={14} />
                    IN YOUR NETWORK
                  </div>
                  {g.meetings
                    .filter((m) => m.status === "extracted" || !m.externalId)
                    .map((m) => (
                    <article className="library-meeting" key={m.id}>
                      <div className="library-row">
                        <span className="meeting-icon">
                          <AudioLines size={21} />
                        </span>
                        <div className="library-title">
                          <strong>{m.title}</strong>
                          <small>
                            {m.date ? new Date(m.date).toLocaleDateString() : "Date unavailable"} · {m.source} ·{" "}
                            {m.entityCount} entities · {m.claimCount} claims
                          </small>
                        </div>
                      </div>
                      <details className="meeting">
                        <summary>
                          <span>View transcript &amp; connections</span>
                          <ChevronDown size={16} />
                        </summary>
                        <div className="meeting-body">
                          <p>{m.transcript}</p>
                          {g.edges
                            .filter((e) => e.evidence.some((ev) => ev.meetingId === m.id))
                            .map((e) => (
                              <div className="meeting-claim" key={e.id}>
                                <strong>
                                  {g.entities.find((n) => n.id === e.source)?.name} →{" "}
                                  {g.entities.find((n) => n.id === e.target)?.name} · {e.kindLabel}
                                </strong>
                                <p>{e.context}</p>
                              </div>
                            ))}
                        </div>
                      </details>
                    </article>
                  ))}
                </>
              )}

              {!listing && !remote.length && !g.meetings.length && !listError && (
                <div className="empty">
                  <AudioLines size={28} />
                  <h3>{connected ? "No meetings returned by Granola" : "Your meeting library is empty"}</h3>
                  <p>
                    {connected
                      ? "Granola returned no meetings in the current range. Refresh to check again."
                      : "Connect Granola to see your meetings here, or paste a transcript."}
                  </p>
                </div>
              )}
            </section>
          )}

          {view === "Entity review" && (
            <section className="content-card">
              <h2>Possible matches</h2>
              <p className="muted">
                These scored between the auto-reject and auto-merge thresholds, so nothing was decided for you.
                The feature breakdown below is the actual input to that score.
              </p>
              {g.reviews.map((r) => (
                <div className="review-card" key={r.id}>
                  <GitMerge size={20} />
                  <div>
                    <strong>
                      {r.name} ↔ {r.candidateName}
                    </strong>
                    <p>{r.context}</p>
                    <small>
                      score {r.score.toFixed(2)} ·{" "}
                      {Object.entries(r.features)
                        .filter(([, v]) => typeof v === "number" && v !== 0)
                        .map(([k, v]) => `${k.replace(/_/g, " ")} ${Number(v).toFixed(2)}`)
                        .join(" · ") || "no distinguishing features"}
                    </small>
                  </div>
                  {(["different", "same"] as const).map((verdict) => (
                    <Button
                      key={verdict}
                      variant={verdict === "same" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await action("/api/review", { reviewId: r.id, verdict });
                          await load();
                        })
                      }
                    >
                      {verdict === "same" ? "Same entity" : "Keep separate"}
                    </Button>
                  ))}
                </div>
              ))}
              {!g.reviews.length && (
                <div className="empty">
                  <Check size={28} />
                  <h3>All identities reviewed</h3>
                  <p>Uncertain matches appear here as your network grows.</p>
                </div>
              )}
            </section>
          )}

          <footer className="page-footer">
            <span>
              <Link2 size={13} />
              Built from conversations. Every edge cites a quote.
            </span>
            <span>network waze</span>
          </footer>
        </main>
      </div>

      <Dialog
        open={!!modal}
        onOpenChange={(o) => {
          if (!o) setModal("");
        }}
      >
        <DialogContent className="app-dialog">
          <DialogTitle>{modal === "settings" ? "Workspace & integrations" : "Add a conversation"}</DialogTitle>
          <DialogDescription>
            {modal === "settings"
              ? "Connect your conversations to your network."
              : "Bring in a Granola meeting or paste a transcript."}
          </DialogDescription>
          {notice && (
            <p role="alert" className="notice">
              {notice}
            </p>
          )}

          {modal === "settings" ? (
            <div className="settings-content">
              <div>
                <AudioLines />
                <strong>Granola</strong>
                <span>{connected ? "Connected with OAuth" : "Not connected"}</span>
              </div>
              <p>
                Granola is used to list meetings and fetch transcripts. Relationship extraction runs on our own
                model against that transcript — Granola&apos;s summarizer is never asked to build the graph.
              </p>
              {connected ? (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setModal("");
                        nav("Meetings");
                        await refreshMeetings();
                      })
                    }
                  >
                    Browse meetings
                    <ArrowRight size={16} />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        await action("/api/granola", { action: "disconnect" });
                        setConnected(false);
                      })
                    }
                  >
                    Disconnect Granola
                  </Button>
                </>
              ) : (
                <a className="connect-link" href="/api/granola/connect">
                  Connect Granola
                  <ArrowUpRight size={16} />
                </a>
              )}
              <div>
                <Sun />
                <strong>Appearance</strong>
                <Button variant="outline" onClick={theme}>
                  {dark ? "Switch to light" : "Switch to dark"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="import-form">
              {connected ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setModal("");
                      nav("Meetings");
                      await refreshMeetings();
                    })
                  }
                >
                  <AudioLines size={17} />
                  Browse Granola meetings
                </Button>
              ) : (
                <a className="connect-link" href="/api/granola/connect">
                  <AudioLines size={17} />
                  Connect Granola
                  <ArrowUpRight size={16} />
                </a>
              )}
              <div className="or-divider">or paste a transcript</div>
              <label>
                Meeting title
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Partnership discussion"
                />
              </label>
              <label>
                Transcript
                <textarea
                  rows={7}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder="Paste the full transcript, including speaker names…"
                />
              </label>
              <p className="muted">
                The transcript is stored immutably and content-hashed, so re-importing the same meeting is a
                no-op rather than a duplicate.
              </p>
              <Button
                disabled={busy || !title.trim() || !transcript.trim() || !canExtract}
                onClick={() =>
                  run(async () => {
                    const d = await action("/api/ingest", { title, text: transcript });
                    await load();
                    setModal("");
                    setTitle("");
                    setTranscript("");
                    setView("Network");
                    setNotice(
                      d.alreadyIngested
                        ? "That transcript is already in your network."
                        : `Extracted ${d.counts.relationships} relationships from ${d.counts.claims} quoted claims.`,
                    );
                  })
                }
              >
                {busy ? "Extracting…" : "Extract connections"}
                <ArrowRight size={16} />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The dossier is line-structured prose that also embeds the outreach hooks,
 * because it is what gets embedded for retrieval. The panel renders hooks in
 * their own section, so strip that block here rather than showing it twice.
 */
function dossierForDisplay(text: string): string {
  const out: string[] = [];
  let inHooks = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "Hooks:") {
      inHooks = true;
      continue;
    }
    if (inHooks) {
      if (line.startsWith("- ")) continue;
      inHooks = false;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Prefer a quote from an offered introduction — that is the actionable one. */
function bestQuote(links: ViewEdge[]) {
  const offered = links.find((l) => l.willingness === "yes" && l.evidence[0]?.quote);
  const any = links.find((l) => l.evidence[0]?.quote);
  const chosen = (offered ?? any)?.evidence[0];
  return chosen?.quote ? chosen : null;
}
