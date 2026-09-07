import Link from "next/link";
import type { SerializedPath } from "@/lib/search/answer";
import { Meter } from "./ui";

/**
 * An introduction route, drawn as a trail rather than a chart.
 *
 * Each hop shows the relationship type, how strong it is, how many meetings
 * back it up, and what was actually said. A route the user cannot audit is a
 * route they will not act on.
 */
export function PathTrail({ path, selfLabel = "You" }: { path: SerializedPath; selfLabel?: string }) {
  return (
    <div className="stack stack--sm">
      <div className="row row--between" style={{ gap: 10 }}>
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 570 }}>{path.targetName}</span>
          <span className="badge">
            {path.hops.length} hop{path.hops.length === 1 ? "" : "s"}
          </span>
          {path.relevance < 0.35 ? <span className="badge">loose match</span> : null}
        </span>
        <Meter value={path.probability} label={`${Math.round(path.probability * 100)}% · ${path.label}`} brand />
      </div>

      <div className="trail">
        <div className="trailNode">
          <div className="trailRail">
            <span className="trailPin trailPin--start" />
            <span className="trailLine" />
          </div>
          <div className="trailBody">
            <div className="trailName">{selfLabel}</div>
            <div className="trailMeta">start</div>
          </div>
        </div>

        {path.hops.map((hop, i) => {
          const last = i === path.hops.length - 1;
          return (
            <div className="trailNode" key={`${hop.toId}-${i}`}>
              <div className="trailRail">
                <span className={last ? "trailPin trailPin--end" : "trailPin"} />
                {last ? null : (
                  <span className={hop.type === "mentioned" ? "trailLine trailLine--dashed" : "trailLine"} />
                )}
              </div>
              <div className="trailBody">
                <div className="trailName">
                  <Link href={`/entity/${hop.toId}`}>{hop.toName}</Link>
                </div>
                <div className="trailMeta">
                  {hop.typeLabel} · {Math.round(hop.strength * 100)}% strength · {hop.evidenceCount} mention
                  {hop.evidenceCount === 1 ? "" : "s"} · {Math.round(hop.probability * 100)}% this hop carries
                </div>
                {hop.context ? <p className="trailQuote">{hop.context}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
