"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { TYPE_COLOR, TYPE_LABEL, Meter, TypeDot } from "./ui";
import { IconClose, IconArrow } from "./Icons";

export interface GraphNodeDTO {
  id: string;
  name: string;
  type: string;
  title: string | null;
  org: string | null;
  degree: number;
  brokerage: number;
  isSelf: boolean;
  needsReview: boolean;
}

export interface GraphEdgeDTO {
  id: string;
  src: string;
  dst: string;
  type: string;
  typeLabel: string;
  strength: number;
  warmth: number;
  evidenceCount: number;
  context: string | null;
  ended: boolean;
}

interface Sim {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  node: GraphNodeDTO;
}

const TYPES = ["person", "organization", "fund", "topic", "event"] as const;

/**
 * A purpose-built force layout on Canvas 2D.
 *
 * Written rather than imported for two reasons: a personal network is small
 * enough that O(n^2) repulsion is free, and the layout needs to know about
 * *edge strength* — strong ties pull tighter — which is the thing that makes the
 * picture legible rather than a hairball.
 */
export function GraphCanvas({
  nodes,
  edges,
  selfId,
}: {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  selfId: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim[]>([]);
  const frameRef = useRef<number>(0);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ mode: "pan" | "node" | null; id?: string; lastX: number; lastY: number }>({
    mode: null,
    lastX: 0,
    lastY: 0,
  });
  const alphaRef = useRef(1);

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(TYPES));
  const [showAwareness, setShowAwareness] = useState(false);
  const [minStrength, setMinStrength] = useState(0);

  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          (showAwareness || e.type !== "mentioned") &&
          e.strength >= minStrength &&
          typeFilter.has(nodeType(nodes, e.src)) &&
          typeFilter.has(nodeType(nodes, e.dst)),
      ),
    [edges, nodes, showAwareness, minStrength, typeFilter],
  );

  const visibleNodes = useMemo(() => nodes.filter((n) => typeFilter.has(n.type)), [nodes, typeFilter]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of visibleEdges) {
      if (!map.has(e.src)) map.set(e.src, new Set());
      if (!map.has(e.dst)) map.set(e.dst, new Set());
      map.get(e.src)!.add(e.dst);
      map.get(e.dst)!.add(e.src);
    }
    return map;
  }, [visibleEdges]);

  // Seed positions once; keep them across filter changes so the map stays stable.
  useEffect(() => {
    const existing = new Map(simRef.current.map((s) => [s.id, s]));
    simRef.current = visibleNodes.map((n, i) => {
      const prev = existing.get(n.id);
      const angle = (i / Math.max(1, visibleNodes.length)) * Math.PI * 2;
      const radius = 180 + (i % 5) * 55;
      return (
        prev ?? {
          id: n.id,
          x: n.isSelf ? 0 : Math.cos(angle) * radius,
          y: n.isSelf ? 0 : Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          r: nodeRadius(n),
          node: n,
        }
      );
    });
    alphaRef.current = 1;
  }, [visibleNodes]);

  const tick = useCallback(() => {
    const sims = simRef.current;
    const alpha = alphaRef.current;
    if (alpha > 0.002) {
      const byId = new Map(sims.map((s) => [s.id, s]));

      // Repulsion — every pair. Fine below a few thousand nodes.
      for (let i = 0; i < sims.length; i++) {
        for (let j = i + 1; j < sims.length; j++) {
          const a = sims[i];
          const b = sims[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            d2 = 4;
          }
          const force = (5200 * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Springs — a strong tie has a shorter rest length and a stiffer pull.
      for (const e of visibleEdges) {
        const a = byId.get(e.src);
        const b = byId.get(e.dst);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const rest = 210 - e.strength * 110;
        const k = (0.035 + e.strength * 0.05) * alpha;
        const force = (d - rest) * k;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Gravity toward the origin, where "you" sits.
      for (const s of sims) {
        s.vx -= s.x * 0.0025 * alpha;
        s.vy -= s.y * 0.0025 * alpha;
        if (s.node.isSelf) {
          s.vx -= s.x * 0.08;
          s.vy -= s.y * 0.08;
        }
        s.vx *= 0.86;
        s.vy *= 0.86;
        s.x += s.vx;
        s.y += s.vy;
      }
      alphaRef.current = alpha * 0.985;
    }
    draw();
    frameRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const css = getComputedStyle(document.documentElement);
    const inkColor = css.getPropertyValue("--ink").trim() || "#16181d";
    const ink2 = css.getPropertyValue("--ink-2").trim() || "#565b66";
    const lineColor = css.getPropertyValue("--border-strong").trim() || "#d3d5dc";
    const surface = css.getPropertyValue("--surface").trim() || "#fff";
    const brand = css.getPropertyValue("--brand").trim() || "#c8102e";

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const view = viewRef.current;
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    const sims = simRef.current;
    const byId = new Map(sims.map((s) => [s.id, s]));
    const focus = selected ?? hovered;
    const neighbours = focus ? adjacency.get(focus) ?? new Set<string>() : null;

    // Edges first, under the nodes.
    for (const e of visibleEdges) {
      const a = byId.get(e.src);
      const b = byId.get(e.dst);
      if (!a || !b) continue;
      const related = !focus || e.src === focus || e.dst === focus;
      const alpha = related ? 0.2 + e.strength * 0.65 : 0.055;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = withAlpha(related && focus ? brand : lineColor, alpha);
      ctx.lineWidth = related && focus ? 1 + e.strength * 2.4 : 0.6 + e.strength * 1.8;
      // A former tie is dashed: real, but no longer current.
      ctx.setLineDash(e.ended ? [5, 4] : e.type === "mentioned" ? [2, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nodes.
    for (const s of sims) {
      const n = s.node;
      const dimmed = Boolean(focus) && focus !== n.id && !neighbours?.has(n.id);
      const color = TYPE_COLOR[n.type] ?? ink2;
      const r = s.r;

      // A 2px surface ring keeps overlapping marks readable.
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(surface, dimmed ? 0.35 : 1);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(color, dimmed ? 0.22 : 1);
      ctx.fill();

      if (n.isSelf) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = brand;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      if (focus === n.id) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(inkColor, 0.5);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // Labels: always for hubs and the focus, otherwise once zoomed in.
      const showLabel = !dimmed && (focus === n.id || n.isSelf || r >= 9 || view.k > 1.35);
      if (showLabel) {
        ctx.font = `${focus === n.id || n.isSelf ? 600 : 500} ${11.5 / Math.max(0.85, Math.min(view.k, 1.25))}px ${
          css.getPropertyValue("--font") || "sans-serif"
        }`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name;
        ctx.lineWidth = 3;
        ctx.strokeStyle = withAlpha(surface, 0.9);
        ctx.strokeText(label, s.x, s.y + r + 5);
        ctx.fillStyle = dimmed ? withAlpha(ink2, 0.4) : inkColor;
        ctx.fillText(label, s.x, s.y + r + 5);
      }
    }
  }, [visibleEdges, selected, hovered, adjacency]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [tick]);

  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - view.x) / view.k,
      y: (clientY - rect.top - rect.height / 2 - view.y) / view.k,
    };
  };

  const hitTest = (clientX: number, clientY: number): Sim | null => {
    const { x, y } = toWorld(clientX, clientY);
    let best: Sim | null = null;
    let bestD = Infinity;
    for (const s of simRef.current) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < s.r + 6 && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    dragRef.current = {
      mode: hit ? "node" : "pan",
      id: hit?.id,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (hit) {
      setSelected(hit.id);
      alphaRef.current = Math.max(alphaRef.current, 0.25);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag.mode) {
      const hit = hitTest(e.clientX, e.clientY);
      setHovered(hit?.id ?? null);
      if (canvasRef.current) canvasRef.current.style.cursor = hit ? "pointer" : "grab";
      return;
    }
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    if (drag.mode === "pan") {
      viewRef.current.x += dx;
      viewRef.current.y += dy;
    } else if (drag.id) {
      const s = simRef.current.find((n) => n.id === drag.id);
      if (s) {
        s.x += dx / viewRef.current.k;
        s.y += dy / viewRef.current.k;
        s.vx = 0;
        s.vy = 0;
        alphaRef.current = Math.max(alphaRef.current, 0.3);
      }
    }
  };

  const onPointerUp = () => {
    dragRef.current = { mode: null, lastX: 0, lastY: 0 };
  };

  const onWheel = (e: React.WheelEvent) => {
    const view = viewRef.current;
    const factor = Math.exp(-e.deltaY * 0.0016);
    view.k = Math.max(0.25, Math.min(3.5, view.k * factor));
  };

  const selectedNode = selected ? nodes.find((n) => n.id === selected) ?? null : null;
  const selectedEdges = selected
    ? visibleEdges
        .filter((e) => e.src === selected || e.dst === selected)
        .sort((a, b) => b.strength - a.strength)
    : [];

  const toggleType = (t: string) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next.size ? next : new Set(TYPES);
    });
  };

  return (
    <div className="graphWrap">
      <canvas
        ref={canvasRef}
        className="graphCanvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      />

      <div className="graphOverlay">
        <div className="graphPanel" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {TYPES.map((t) => (
              <button
                key={t}
                className="chip"
                aria-pressed={typeFilter.has(t)}
                onClick={() => toggleType(t)}
              >
                <TypeDot type={t} />
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="row row--wrap" style={{ gap: 10 }}>
            <button className="chip" aria-pressed={showAwareness} onClick={() => setShowAwareness((v) => !v)}>
              Show awareness edges
            </button>
            <label className="row xsmall muted" style={{ gap: 7 }}>
              Min strength
              <input
                type="range"
                min={0}
                max={0.8}
                step={0.05}
                value={minStrength}
                onChange={(e) => setMinStrength(Number(e.target.value))}
                style={{ width: 92, accentColor: "var(--brand)" }}
              />
              <span className="tnum" style={{ width: 24 }}>
                {minStrength.toFixed(2)}
              </span>
            </label>
            <span className="xsmall muted tnum">
              {visibleNodes.length} nodes · {visibleEdges.length} edges
            </span>
          </div>
          <div className="legend" style={{ padding: 0 }}>
            <span className="legendItem">
              <svg width="22" height="6">
                <line x1="0" y1="3" x2="22" y2="3" stroke="var(--border-strong)" strokeWidth="2" />
              </svg>
              current tie
            </span>
            <span className="legendItem">
              <svg width="22" height="6">
                <line x1="0" y1="3" x2="22" y2="3" stroke="var(--border-strong)" strokeWidth="2" strokeDasharray="5 4" />
              </svg>
              former tie
            </span>
            <span className="legendItem">
              <svg width="22" height="6">
                <line x1="0" y1="3" x2="22" y2="3" stroke="var(--border-strong)" strokeWidth="2" strokeDasharray="2 4" />
              </svg>
              awareness only
            </span>
            <span className="legendItem">thicker = stronger</span>
          </div>
        </div>
      </div>

      {selectedNode ? (
        <aside className="graphPanel inspector">
          <div className="cardHead" style={{ position: "sticky", top: 0, background: "inherit", zIndex: 2 }}>
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <TypeDot type={selectedNode.type} />
              <span className="truncate" style={{ fontWeight: 600 }}>
                {selectedNode.name}
              </span>
            </div>
            <button className="btn btn--ghost btn--icon" onClick={() => setSelected(null)} aria-label="Close">
              <IconClose size={14} />
            </button>
          </div>

          <div className="cardBody stack">
            <div className="stack stack--sm">
              {selectedNode.title ? <span className="small">{selectedNode.title}</span> : null}
              {selectedNode.org ? <span className="small dim">{selectedNode.org}</span> : null}
              <div className="row row--wrap" style={{ gap: 6 }}>
                <span className="badge">{TYPE_LABEL[selectedNode.type] ?? selectedNode.type}</span>
                {selectedNode.isSelf ? <span className="badge badge--brand">You</span> : null}
                {selectedNode.needsReview ? <span className="badge badge--warn">Needs review</span> : null}
                <span className="badge">{selectedNode.degree} connections</span>
              </div>
            </div>

            {selectedNode.brokerage > 0.05 ? (
              <div className="stack stack--sm">
                <span className="xsmall muted">Brokerage</span>
                <Meter value={selectedNode.brokerage} brand />
                <span className="xsmall muted">
                  Share of their neighbourhood that is reachable only through them.
                </span>
              </div>
            ) : null}

            <div className="stack stack--sm">
              <span className="xsmall muted">Connections</span>
              {selectedEdges.slice(0, 14).map((e) => {
                const otherId = e.src === selected ? e.dst : e.src;
                const other = nodes.find((n) => n.id === otherId);
                return (
                  <button
                    key={e.id}
                    className="stack stack--sm"
                    onClick={() => setSelected(otherId)}
                    style={{
                      textAlign: "left",
                      background: "none",
                      border: "none",
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                  >
                    <span className="row" style={{ gap: 7 }}>
                      <TypeDot type={other?.type ?? "person"} />
                      <span style={{ fontWeight: 545, fontSize: 13 }}>{other?.name ?? "Unknown"}</span>
                      <span className="spacer" />
                      <Meter value={e.strength} label="" />
                    </span>
                    <span className="xsmall muted">
                      {e.typeLabel}
                      {e.ended ? " (former)" : ""} · {e.evidenceCount} mention
                      {e.evidenceCount === 1 ? "" : "s"}
                    </span>
                    {e.context ? <span className="xsmall dim">{e.context}</span> : null}
                  </button>
                );
              })}
            </div>

            <Link href={`/entity/${selectedNode.id}`} className="btn btn--sm">
              Open full profile <IconArrow size={12} />
            </Link>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function nodeType(nodes: GraphNodeDTO[], id: string): string {
  return nodes.find((n) => n.id === id)?.type ?? "person";
}

function nodeRadius(n: GraphNodeDTO): number {
  if (n.isSelf) return 13;
  return Math.max(5, Math.min(15, 4.5 + Math.sqrt(n.degree) * 2.1));
}

/** Accepts hex or any CSS colour token already resolved by getComputedStyle. */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    const full =
      c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
    const r = parseInt(full.slice(1, 3), 16);
    const g = parseInt(full.slice(3, 5), 16);
    const b = parseInt(full.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (c.startsWith("rgb")) {
    return c.replace(/rgba?\(([^)]+)\)/, (_m, inner) => {
      const parts = String(inner).split(",").slice(0, 3).map((p) => p.trim());
      return `rgba(${parts.join(", ")}, ${alpha})`;
    });
  }
  return c;
}
