"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Minus, Maximize2, RotateCcw } from "lucide-react";
import type { ViewEntity, ViewEdge } from "@/lib/view-model";
import { networkLayout, fitNetwork, type Point } from "@/lib/network-layout";

interface CanvasGraph {
  entities: ViewEntity[];
  edges: ViewEdge[];
}

interface Sim {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  node: ViewEntity;
}

type Camera = { x: number; y: number; k: number };

/** Awareness ("A talked about B") is not a relationship — see ARCHITECTURE.md. */
const AWARENESS = new Set(["mentioned"]);

/**
 * The live network.
 *
 * Positions are seeded from the deterministic clustered layout, so the graph
 * always *opens* the same way and the spatial memory you build of your own
 * network survives a reload. From there a force simulation keeps running: drag a
 * node and its neighbours follow, because a relationship graph that reacts is one
 * you can actually explore.
 *
 * The simulation writes transforms straight to the DOM rather than through React
 * state. Re-rendering a hundred nodes at 60fps would drop frames for no benefit —
 * React owns the structure, the loop owns the positions.
 *
 * The loop parks itself once the graph settles (`alpha` decays below a floor) and
 * `wake()` restarts it on interaction, so an idle tab costs nothing.
 */
export function NetworkCanvas({
  graph,
  visible,
  selected,
  onSelect,
  empty,
}: {
  graph: CanvasGraph;
  visible: ViewEntity[];
  selected: string;
  onSelect: (id: string) => void;
  empty: React.ReactNode;
}) {
  const [showAwareness, setShowAwareness] = useState(true);
  const [minStrength, setMinStrength] = useState(0);
  const [zoomPct, setZoomPct] = useState(100);

  const svgRef = useRef<SVGSVGElement>(null);
  const rootRef = useRef<SVGGElement>(null);
  const simRef = useRef<Sim[]>([]);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());
  const alphaRef = useRef(0.35);
  const frameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 850, height: 540 });
  const viewportRef = useRef({ width: 850, height: 540 });
  const cameraRef = useRef<Camera>({ x: 425, y: 250, k: 1 });
  const dragRef = useRef<{ pointer: number; id?: string; lastX: number; lastY: number; moved: boolean } | null>(null);

  // Which edges take part in the layout and get drawn. Hiding awareness edges
  // has to relax the springs too, or the picture stops matching the physics.
  const activeEdges = useMemo(
    () => graph.edges.filter((e) => (showAwareness || !AWARENESS.has(e.kind)) && e.strength >= minStrength),
    [graph.edges, showAwareness, minStrength],
  );

  // Re-seed only when the graph's shape changes, never when a score does.
  const topology = useMemo(
    () => JSON.stringify([graph.entities.map((e) => e.id).sort(), graph.edges.map((e) => [e.source, e.target]).sort()]),
    [graph.entities, graph.edges],
  );

  const applyCamera = useCallback(() => {
    const c = cameraRef.current;
    rootRef.current?.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.k})`);
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      cameraRef.current.x += (width - viewportRef.current.width) / 2;
      cameraRef.current.y += (height - viewportRef.current.height) / 2;
      viewportRef.current = { width, height };
      setViewport({ width, height });
      applyCamera();
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [applyCamera]);

  function fitViewport(points: Record<string, Point>) {
    const c = fitNetwork(points);
    const { width, height } = viewportRef.current;
    const scale = Math.max(.1, Math.min((width - 48) / 850, (height - 200) / 540));
    return { k: c.k * scale, x: width / 2 + (c.x - 425) * scale, y: height / 2 + (c.y - 250) * scale };
  }

  const wake = useCallback((heat: number) => {
    alphaRef.current = Math.max(alphaRef.current, heat);
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One physics tick plus a paint. Defined via ref so `wake` can reach it. */
  const stepRef = useRef<() => void>(() => {});
  function step() {
    stepRef.current();
  }

  const seed = useCallback(() => {
    const base = networkLayout(graph);
    simRef.current = graph.entities.map((node) => {
      const p: Point = base[node.id] ?? { x: 0, y: 0 };
      return { id: node.id, x: p.x, y: p.y, vx: 0, vy: 0, node };
    });
    cameraRef.current = fitViewport(base);
    setZoomPct(Math.round(cameraRef.current.k * 100));
    applyCamera();
    alphaRef.current = 0.35;
  }, [graph, applyCamera]);

  useEffect(() => {
    seed();
    wake(0.35);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology]);

  // The loop. Reads the latest edges/selection through the closure it is
  // redefined with on every render, which is cheap — it is one assignment.
  stepRef.current = () => {
    const sims = simRef.current;
    let alpha = alphaRef.current;

    const dragging = dragRef.current?.id;

    if (alpha > 0.002) {
      const byId = new Map(sims.map((s) => [s.id, s]));

      // The force constants are the ones the deterministic layout was tuned
      // with, so the live simulation settles to the same kind of arrangement
      // rather than fighting the seed it started from.
      for (let i = 0; i < sims.length; i++) {
        for (let j = i + 1; j < sims.length; j++) {
          const a = sims[i];
          const b = sims[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            d = 2;
          }
          const force = Math.min(18, 2500 / (d * d) + Math.max(0, 140 - d) * 0.08) * alpha;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Springs: a strong tie rests shorter and pulls harder, so the layout
      // itself encodes strength rather than leaving it to the stroke alone.
      for (const e of activeEdges) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const rest = 205 - e.strength * 60;
        const force = (d - rest) * (0.012 + e.strength * 0.014) * alpha;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const s of sims) {
        // Weak gravity: enough to stop detached components drifting away,
        // not enough to pull the graph into a ball.
        s.vx -= s.x * 0.0009 * alpha;
        s.vy -= s.y * 0.0009 * alpha;
        // "You" is the origin the rest of the network arranges itself around.
        if (s.node.isSelf) {
          s.vx -= s.x * 0.012;
          s.vy -= s.y * 0.012;
        }
        s.vx *= 0.78;
        s.vy *= 0.78;
        if (s.id === dragging) {
          // A node under the cursor is held, not simulated.
          s.vx = 0;
          s.vy = 0;
          continue;
        }
        s.x += s.vx;
        s.y += s.vy;
      }

      alpha *= 0.985;
      alphaRef.current = alpha;
    }

    // Collision is a position constraint, not a force, and it runs on every
    // tick regardless of alpha. Forces fade as the graph cools, so a
    // force-based version lets nodes settle on top of each other — which is
    // exactly what makes a label unreadable. This guarantees they never do.
    separate(sims, dragging);

    paint();

    if (alpha > 0.002 || dragRef.current?.id) {
      frameRef.current = requestAnimationFrame(step);
    } else {
      // Settled: stop burning frames until something happens.
      frameRef.current = null;
    }
  };

  const paint = () => {
    const pos = new Map(simRef.current.map((s) => [s.id, s]));
    for (const [id, el] of nodeEls.current) {
      const s = pos.get(id);
      if (s) el.setAttribute("transform", `translate(${s.x} ${s.y})`);
    }
    for (const [id, el] of edgeEls.current) {
      const edge = edgeIndex.current.get(id);
      if (!edge) continue;
      const a = pos.get(edge.source);
      const b = pos.get(edge.target);
      if (!a || !b) continue;
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(b.x));
      el.setAttribute("y2", String(b.y));
    }
  };

  const edgeIndex = useRef(new Map<string, ViewEdge>());
  edgeIndex.current = new Map(activeEdges.map((e) => [e.id, e]));

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  // Edge set changed: the springs are different, so let it re-settle.
  useEffect(() => {
    wake(0.25);
  }, [activeEdges, wake]);

  const local = (x: number, y: number) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return { x, y };
    return new DOMPoint(x, y).matrixTransform(matrix.inverse());
  };

  const zoom = (factor: number, anchor: Point = { x: viewportRef.current.width / 2, y: viewportRef.current.height / 2 }) => {
    const c = cameraRef.current;
    const k = Math.min(4, Math.max(0.08, c.k * factor));
    const ratio = k / c.k;
    cameraRef.current = { k, x: anchor.x - (anchor.x - c.x) * ratio, y: anchor.y - (anchor.y - c.y) * ratio };
    applyCamera();
    setZoomPct(Math.round(k * 100));
  };

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.0015), local(e.clientX, e.clientY));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleIds = useMemo(() => new Set(visible.map((e) => e.id)), [visible]);
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    for (const e of activeEdges) {
      if (e.source === selected) set.add(e.target);
      if (e.target === selected) set.add(e.source);
    }
    return set;
  }, [activeEdges, selected]);

  function onPointerDown(e: React.PointerEvent, id?: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { pointer: e.pointerId, id, lastX: e.clientX, lastY: e.clientY, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
    if (id) wake(0.5);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;

    if (drag.id) {
      const s = simRef.current.find((n) => n.id === drag.id);
      if (s) {
        s.x += dx / cameraRef.current.k;
        s.y += dy / cameraRef.current.k;
        // Held nodes drag their neighbourhood along with them.
        wake(0.45);
      }
    } else {
      cameraRef.current.x += dx;
      cameraRef.current.y += dy;
      applyCamera();
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    // A press that never moved is a click; selecting must not demand precision.
    if (drag.id && !drag.moved) onSelect(drag.id);
    dragRef.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    wake(0.15);
  }

  function fit() {
    const points = Object.fromEntries(simRef.current.map((s) => [s.id, { x: s.x, y: s.y }]));
    cameraRef.current = fitViewport(points);
    applyCamera();
    setZoomPct(Math.round(cameraRef.current.k * 100));
  }

  return (
    <div className="graph-canvas interactive-network">
      <div className="graph-controls">
        <button
          type="button"
          className={`chip ${showAwareness ? "on" : ""}`}
          aria-pressed={showAwareness}
          onClick={() => setShowAwareness((v) => !v)}
        >
          <svg width="20" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="2 4" />
          </svg>
          Awareness edges
        </button>
        <label className="chip-range">
          Min strength
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={minStrength}
            onChange={(e) => setMinStrength(Number(e.target.value))}
            aria-label="Minimum edge strength"
          />
          <span>{minStrength.toFixed(2)}</span>
        </label>
        <span className="graph-count">
          {visible.length} nodes · {activeEdges.length} edges
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        aria-label="Relationship network. Drag nodes to rearrange them, drag the background to pan, scroll to zoom."
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <defs>
          <pattern id="network-dots" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".8" fill="var(--dot)" />
          </pattern>
        </defs>
        <rect width={viewport.width} height={viewport.height} fill="url(#network-dots)" />

        <g ref={rootRef}>
          {activeEdges.map((e) => {
            const hot = e.source === selected || e.target === selected;
            const shown = visibleIds.has(e.source) && visibleIds.has(e.target);
            const awareness = AWARENESS.has(e.kind);
            return (
              <g
                key={e.id}
                className={`graph-edge ${hot ? "hot" : ""}`}
                opacity={shown ? (hot ? Math.max(0.75, 0.2 + e.strength * 0.7) : 0.16 + e.strength * 0.5) : 0.05}
              >
                <line
                  ref={(el) => {
                    if (el) edgeEls.current.set(e.id, el);
                    else edgeEls.current.delete(e.id);
                  }}
                  style={{
                    vectorEffect: "non-scaling-stroke",
                    strokeWidth: (hot ? 1.3 : 0.7) + e.strength * 2.1,
                  }}
                  // Solid = current, dashed = former, dotted = awareness only.
                  strokeDasharray={e.ended ? "5 4" : awareness ? "2 4" : undefined}
                />
                <title>
                  {e.kindLabel}
                  {e.ended ? " (ended)" : ""} · strength {Math.round(e.strength * 100)}% · warmth{" "}
                  {Math.round(e.warmth * 100)}%{e.context ? ` — ${e.context}` : ""}
                </title>
              </g>
            );
          })}

          {graph.entities.map((n) => (
            <g
              key={n.id}
              ref={(el) => {
                if (el) nodeEls.current.set(n.id, el);
                else nodeEls.current.delete(n.id);
              }}
              role="button"
              tabIndex={visibleIds.has(n.id) ? 0 : -1}
              aria-label={`View ${n.name}`}
              onPointerDown={(e) => onPointerDown(e, n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(n.id);
                  return;
                }
                const nudge: Record<string, Point> = {
                  ArrowLeft: { x: -15, y: 0 },
                  ArrowRight: { x: 15, y: 0 },
                  ArrowUp: { x: 0, y: -15 },
                  ArrowDown: { x: 0, y: 15 },
                };
                const d = nudge[e.key];
                if (!d) return;
                e.preventDefault();
                const s = simRef.current.find((x) => x.id === n.id);
                if (s) {
                  s.x += d.x;
                  s.y += d.y;
                  wake(0.35);
                }
              }}
              className={`graph-node ${n.type} ${n.isSelf ? "self" : ""} ${selected === n.id ? "chosen" : ""}`}
              opacity={visibleIds.has(n.id) ? 1 : 0.12}
            >
              <title>
                {n.name} — {n.role}
                {n.brokerage > 0 ? ` · broker score ${Math.round(n.brokerage * 100)}` : ""}
              </title>
              <circle className="halo" r={neighbours.has(n.id) ? 34 : 30} />
              <rect className="node-shape" x="-24" y="-24" width="48" height="48" rx={n.type === "person" ? 24 : 12} />
              <text className="initials" textAnchor="middle" y="5">
                {initials(n.name)}
              </text>
              <text className="node-label" textAnchor="middle" y="44">
                {n.name.length > 27 ? `${n.name.slice(0, 25)}…` : n.name}
              </text>
              {selected === n.id && (
                <text className="node-role" textAnchor="middle" y="63">
                  {n.role.length > 35 ? `${n.role.slice(0, 33)}…` : n.role}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      {!visible.length && empty}

      <div className="graph-footer">
        <div className="legend">
          <span className="legendItem">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="2" />
            </svg>
            current tie
          </span>
          <span className="legendItem">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" />
            </svg>
            former tie
          </span>
          <span className="legendItem">
            <svg width="22" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="2 4" />
            </svg>
            awareness only
          </span>
          <span className="legendItem">thicker = stronger</span>
          <span className="legendItem">
            <i className="swatch person" aria-hidden="true" />
            person
          </span>
          <span className="legendItem">
            <i className="swatch org" aria-hidden="true" />
            organization
          </span>
        </div>
        <div className="zoom">
          <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
            <Minus size={15} />
          </button>
          <span>{zoomPct}%</span>
          <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
            <Plus size={15} />
          </button>
          <button aria-label="Fit network to view" onClick={fit}>
            <Maximize2 size={15} />
          </button>
          <button
            aria-label="Reset network layout"
            onClick={() => {
              seed();
              wake(0.6);
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name.split(" ").map((x) => x[0]).slice(0, 2).join("");
}

/**
 * Push overlapping nodes apart, in position rather than velocity.
 *
 * The radius covers the 48px mark plus the label that hangs beneath it, and is
 * wider than it is tall because names are wide. A node being dragged is treated
 * as immovable so it goes exactly where the cursor put it.
 */
function separate(sims: Sim[], dragging?: string): void {
  const RX = 62;
  const RY = 46;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < sims.length; i++) {
      for (let j = i + 1; j < sims.length; j++) {
        const a = sims[i];
        const b = sims[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        // Measure in a space where the ellipse is a circle, then map back.
        const nx = dx / RX;
        const ny = dy / RY;
        let d = Math.hypot(nx, ny);
        if (d >= 1) continue;
        if (d < 0.0001) {
          dx = (Math.random() - 0.5) || 0.5;
          dy = (Math.random() - 0.5) || 0.5;
          d = 0.0001;
        }
        const overlap = (1 - d) / Math.max(d, 0.0001);
        const pushX = dx * overlap * 0.5;
        const pushY = dy * overlap * 0.5;
        const aFixed = a.id === dragging;
        const bFixed = b.id === dragging;
        if (aFixed && bFixed) continue;
        if (aFixed) {
          b.x += pushX * 2;
          b.y += pushY * 2;
        } else if (bFixed) {
          a.x -= pushX * 2;
          a.y -= pushY * 2;
        } else {
          a.x -= pushX;
          a.y -= pushY;
          b.x += pushX;
          b.y += pushY;
        }
      }
    }
  }
}
