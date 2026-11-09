"use client";

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { ArrowRight, Check, CheckCheck, Circle, GitBranch, LayoutGrid, Plus, Search, Trash2, X } from "lucide-react";
import { dependencyBlockers, LOOP_STATES, needsMyMove, ownerName, pathDisplayColor, type LoopItem, type LoopPath } from "@/lib/loops";
import type { ViewEntity } from "@/lib/view-model";
import { StyledSelect } from "./ui/select";
import { Button } from "./ui/button";

type Props = {
  paths: LoopPath[] | null; people: ViewEntity[]; status: string; error: string; conflict: boolean;
  onRetry: () => void; onRecover: () => void; onOverview: () => void;
  onCapture: (text: string, path: string) => boolean;
  onChange: (id: string, patch: Partial<LoopItem>) => boolean;
  onResolve: (item: LoopItem) => void; onMove: (id: string, path: string) => void;
  onDelete: (id: string) => void; onClear: (item: LoopItem) => void; onAddBoard: (name: string) => boolean;
  feedback: { text: string; undo?: () => void } | null; onDismiss: () => void;
  renderDetails: (item: LoopItem, path: LoopPath) => ReactNode;
};

export function LoopsFocusBoard(props: Props) {
  const { paths, people } = props;
  const [boardId, setBoardId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [addingBoard, setAddingBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [dragged, setDragged] = useState("");
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const board = paths?.find(p => p.id === boardId) ?? paths?.find(p => p.items.some(i => !i.resolved)) ?? paths?.[0];
  const selectedPath = paths?.find(p => p.items.some(i => i.id === selectedId));
  const selected = selectedPath?.items.find(i => i.id === selectedId);
  const all = paths?.flatMap(p => p.items) ?? [];
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const counts = { open: board?.items.filter(i => !i.resolved).length ?? 0, me: board?.items.filter(i => !i.resolved && needsMyMove(i, today) && !dependencyBlockers(i, all).length).length ?? 0, waiting: board?.items.filter(i => !i.resolved && i.state === "waiting").length ?? 0, done: board?.items.filter(i => i.resolved).length ?? 0 };
  const items = board?.items.filter(i => (filter === "done" ? i.resolved : !i.resolved && (filter === "me" ? needsMyMove(i, today) && !dependencyBlockers(i, all).length : filter === "waiting" ? i.state === "waiting" : true)) && `${i.title} ${i.context} ${i.next}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  function close() { setSelectedId(""); opener.current?.focus(); }
  useEffect(() => { if (selectedId) panel.current?.focus(); }, [selectedId]);
  function switchBoard(id: string) { setBoardId(id); setSelectedId(""); setQuery(""); }
  const groups = [...new Set(paths?.map(p => p.stack?.name ?? "Boards") ?? [])];
  return <section className={`focus-loops ${selected ? "has-inspector" : ""}`}>
    <nav className="focus-navigation" aria-label="Loop boards">
      <div className="focus-nav-title"><span>Loops</span><span className="focus-beta">Board</span></div>
      <button className="focus-overview" onClick={props.onOverview}><LayoutGrid size={15} /> All boards & chains <ArrowRight size={13} /></button>
      <div className="focus-board-navigation">{groups.map(group => <div key={group} className="focus-nav-group"><h2>{group}</h2>{paths?.filter(p => (p.stack?.name ?? "Boards") === group).map(p => <button key={p.id} aria-current={p.id === board?.id ? "page" : undefined} onClick={() => switchBoard(p.id)} onDragOver={e => { if (dragged) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (dragged) props.onMove(dragged, p.id); setDragged(""); }}><i style={{ background: pathDisplayColor(p.color) }} /><span>{p.name}</span><small>{p.items.filter(i => !i.resolved).length}</small></button>)}</div>)}</div>
      {addingBoard ? <form className="focus-new-board" onSubmit={e => { e.preventDefault(); if (boardName.trim() && props.onAddBoard(boardName.trim())) { setBoardName(""); setAddingBoard(false); } }}><input autoFocus aria-label="Board name" placeholder="Board name" value={boardName} maxLength={100} onChange={e => setBoardName(e.target.value)} /><Button size="sm" type="submit">Create</Button><button type="button" aria-label="Cancel new board" onClick={() => setAddingBoard(false)}><X size={14} /></button></form> : <button className="focus-new-board" disabled={!paths} onClick={() => setAddingBoard(true)}><Plus size={15} /> New board</button>}
      <div className="focus-nav-foot"><span className={props.error ? "focus-error-dot" : "focus-saved-dot"} /><span role="status">{props.status}</span></div>
    </nav>
    <div className="focus-main">
      <header className="focus-header"><div className="focus-breadcrumb">Loops <span>/</span> {board?.stack?.name ?? "Workspace"}</div><div className="focus-heading"><div><h1>{board?.name ?? "Loading your loops…"}</h1><p>{counts.open} open loops<span>·</span>Keep the next move in sight.</p></div><Button disabled={!board} onClick={() => setComposing(true)}><Plus size={15} /> Add loop</Button></div></header>
      <div className="focus-toolbar"><div className="focus-tabs" aria-label="Filter loops">{([["open", "Open"], ["me", "Needs me"], ["waiting", "Waiting"], ["done", "Completed"]] as const).map(([id, name]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}<span>{counts[id]}</span></button>)}</div><label className="focus-search"><Search size={14} /><input aria-label="Search this board" placeholder="Search loops" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      {props.error && <div className="focus-error" role="alert">{props.error}<button onClick={props.onRetry}>Retry</button>{props.conflict && <button onClick={props.onRecover}>Keep a copy & refresh</button>}</div>}
      <div className="focus-board-content">
        {composing && <form className="focus-composer" onSubmit={e => { e.preventDefault(); if (board && props.onCapture(draft, board.id)) { setDraft(""); setComposing(false); setFilter("open"); setQuery(""); } }}><label htmlFor="focus-capture">New loop <small>One per line for quick capture</small></label><textarea id="focus-capture" autoFocus placeholder="What needs to move forward?" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setComposing(false); }} /><div><Button type="button" variant="ghost" onClick={() => setComposing(false)}>Cancel</Button><Button type="submit" disabled={!draft.trim()}>Add to {board?.name}</Button></div></form>}
        <div className="focus-section-label"><span>{filter === "done" ? "COMPLETED LOOPS" : "YOUR LOOPS"}</span><span>{items.length} {items.length === 1 ? "loop" : "loops"}</span></div>
        <div className="focus-card-grid">{items.map(item => {
          const blockers = dependencyBlockers(item, all);
          const next = item.next || item.steps?.find(s => !s.done)?.text;
          return <article key={item.id} className={`focus-card ${selectedId === item.id ? "is-selected" : ""} ${item.resolved ? "is-complete" : ""}`} style={{ "--card-color": pathDisplayColor(board!.color) } as CSSProperties} draggable onDragStart={e => { setDragged(item.id); e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragged("")}>
            <div className="focus-card-top"><span className={`focus-state state-${item.state}`}>{item.resolved ? "Completed" : LOOP_STATES[item.state]}</span><button className="focus-complete" disabled={!item.resolved && blockers.length > 0} title={blockers.length && !item.resolved ? "Complete prerequisites first" : undefined} aria-label={`${item.resolved ? "Reopen" : "Complete"} ${item.title}`} onClick={() => props.onResolve(item)}>{item.resolved ? <CheckCheck size={17} /> : <Circle size={17} />}</button></div>
            <button className="focus-card-open" aria-expanded={selectedId === item.id} onClick={e => { opener.current = e.currentTarget; setSelectedId(item.id); }}><h2>{item.title}</h2><p>{next ? <><ArrowRight size={13} /><span>{next}</span></> : <span className="focus-no-step">Add a next step</span>}</p></button>
            <div className="focus-card-footer"><span className="focus-owner"><span>{(ownerName(item, people) || "?").slice(0, 1)}</span>{ownerName(item, people) || "Unassigned"}</span>{blockers.length > 0 ? <span title={blockers.map(i => i.title).join(", ")}><GitBranch size={12} />Blocked</span> : item.review ? <span className={item.review <= today && !item.resolved ? "focus-review-due" : ""}>{new Date(`${item.review}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span> : item.context ? <span>Description</span> : null}</div>
          </article>;
        })}</div>
        {paths && !items.length && <div className="focus-empty"><Check size={25} /><h2>{query ? "No matching loops" : filter === "open" ? "A little room to think" : "Nothing here right now"}</h2><p>{query ? "Try another search or clear your filters." : filter === "open" ? "Capture what’s on your mind. Give it a next step when you’re ready." : "Loops that match this view will appear here."}</p>{filter === "open" && !query && <Button variant="outline" onClick={() => setComposing(true)}><Plus size={14} /> Add your first loop</Button>}</div>}
      </div>
    </div>
    {selected && selectedPath && <aside ref={panel} tabIndex={-1} className="focus-inspector" aria-label={`Loop details: ${selected.title}`} onKeyDown={e => { if (e.key === "Escape" && !(e.target instanceof Element && e.target.closest(".select-positioner"))) { e.stopPropagation(); close(); } }}>
      <div className="focus-inspector-top"><span>LOOP DETAILS</span><button aria-label="Close loop details" onClick={close}><X size={18} /></button></div>
      <div className="focus-inspector-scroll"><textarea key={selected.id} className="focus-detail-title" aria-label="Loop title" rows={2} maxLength={200} value={selected.title} onChange={e => { if (e.target.value.trim()) props.onChange(selected.id, { title: e.target.value }); }} />
        <div className="focus-properties"><label>Status<StyledSelect label="Loop status" value={selected.state} onChange={state => props.onChange(selected.id, { state: state as LoopItem["state"] })} options={Object.entries(LOOP_STATES).map(([value, label]) => ({ value, label }))} /></label><label>Next move<StyledSelect label="Next move owner" value={selected.ownerId} onChange={ownerId => props.onChange(selected.id, { ownerId })} options={[{ value: "", label: "Unassigned" }, { value: "me", label: "Me" }, ...selected.people.map(p => ({ value: p.id, label: people.find(e => e.id === p.id)?.name ?? p.name }))]} /></label><label>Board<StyledSelect label="Move loop to board" value={selectedPath.id} onChange={id => { props.onMove(selected.id, id); setBoardId(id); }} options={paths!.map(p => ({ value: p.id, label: p.name }))} /></label><label>Review date<input type="date" value={selected.review} onChange={e => props.onChange(selected.id, { review: e.target.value })} /></label></div>
        {selected.dependsOn.length > 0 && <section className="focus-detail-section"><h3>Prerequisites</h3>{selected.dependsOn.map(id => { const parent = all.find(i => i.id === id); return parent && <button key={id} className="focus-prerequisite" onClick={() => setSelectedId(id)}>{parent.resolved ? <Check size={14} /> : <GitBranch size={14} />}{parent.title}</button>; })}</section>}
        {props.renderDetails(selected, selectedPath)}
      </div><div className="focus-inspector-footer"><Button variant="outline" onClick={() => props.onResolve(selected)} disabled={!selected.resolved && dependencyBlockers(selected, all).length > 0}>{selected.resolved ? "Reopen loop" : <><Check size={14} /> Complete loop</>}</Button>{selected.resolved && !selected.clearedAt && <Button variant="ghost" onClick={() => props.onClear(selected)}>Clear</Button>}<button aria-label="Delete loop" title="Delete loop" onClick={() => { props.onDelete(selected.id); close(); }}><Trash2 size={15} /></button></div>
    </aside>}
    {props.feedback?.undo && <div className="focus-toast" role="status"><Check size={15} /><span>{props.feedback.text}</span><button onClick={() => { props.feedback?.undo?.(); props.onDismiss(); }}>Undo</button><button aria-label="Dismiss update" onClick={props.onDismiss}><X size={14} /></button></div>}
  </section>;
}
