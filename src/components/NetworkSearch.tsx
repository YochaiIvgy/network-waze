"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Search } from "lucide-react";

/** A local composer preview. Deliberately does not call the search API. */
export function NetworkSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        // Preserve the clicked target's focus and any interaction with the canvas.
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);
  function close() { setOpen(false); trigger.current?.focus(); }
  return (
    <div ref={container} className={`network-search ${open ? "is-open" : ""}`} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <button ref={trigger} className="search-launcher" aria-expanded={open} aria-controls="network-composer" onClick={() => setOpen(true)} tabIndex={open ? -1 : 0} aria-hidden={open}>
        <img className="search-logo" src="/46c.png" alt="46" /><span>Ask your network</span><Search size={16} />
      </button>
      <form id="network-composer" className="network-composer" inert={!open} aria-label="Natural language network search" onSubmit={e => { e.preventDefault(); if (query.trim()) setSubmitted(true); }}>
        <textarea ref={input} rows={2} aria-label="Ask a question about your network" placeholder="Who can help me get an introduction to…" value={query} onChange={e => { setQuery(e.target.value); setSubmitted(false); }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (query.trim()) setSubmitted(true); } }} />
        <div className="composer-bottom"><span role="status">{submitted ? "Search is coming soon. Your question stays here." : "Find people, discover connections, explore possibilities."}</span><button className="composer-send" type="submit" disabled={!query.trim()} aria-label="Preview network search"><ArrowUp size={18} /></button></div>
      </form>
    </div>
  );
}
