"use client";

import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ArrowUp, Check, ChevronDown, GripVertical, Plus, X } from "lucide-react";
import { PersonPicker } from "./LoopPersonPicker";
import { StyledSelect } from "./ui/select";
import { LOOP_STATES, PATH_COLORS, captureLoops, completeNext, loopsSchema, moveItem, needsMyMove, ownerName, recordLoop, planSteps, toggleStep, type LoopItem, type LoopPath } from "@/lib/loops";
import type { ViewEntity } from "@/lib/view-model";

type Drag = { type: "path" | "item"; id: string };
type Filter = "all" | "me" | "waiting";
const stateOptions = Object.entries(LOOP_STATES).map(([value, label], index) => ({ value, label, color: ["#63896e", "#b28b3b", "#a371ab", "#548caf"][index] }));

export function LoopsBoard({ entities, refreshPeople }: { entities: ViewEntity[]; refreshPeople: () => Promise<void> }) {
  const [paths, setPaths] = useState<LoopPath[] | null>(null);
  const latest = useRef<LoopPath[] | null>(null);
  const revision = useRef(0);
  const pending = useRef(false);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const journal = useRef("");
  const initialized = useRef(false);
  const [draftPrefix, setDraftPrefix] = useState("");
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [backupError, setBackupError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [capturePath, setCapturePath] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pathName, setPathName] = useState("");
  const [addingPath, setAddingPath] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; undoId?: string } | null>(null);
  const people = entities.filter(e => e.type === "person");

  function keepDraft(board: LoopPath[]) {
    try { localStorage.setItem(journal.current, JSON.stringify({ revision: revision.current, paths: board })); setBackupError(""); }
    catch { setBackupError("Browser backup is unavailable. Keep this tab open until changes are saved."); }
  }
  async function load(discardDraft = false) {
    setError("");
    try {
      const response = await fetch("/api/loops"); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Loops.");
      let tabId = sessionStorage.getItem("waze-loops-tab");
      if (!tabId) { tabId = crypto.randomUUID(); sessionStorage.setItem("waze-loops-tab", tabId); }
      journal.current = `waze-loops:${data.workspaceId}:${tabId}`; setDraftPrefix(journal.current);
      let board: LoopPath[] = data.paths === null ? [{ id: crypto.randomUUID(), name: "Inbox", color: PATH_COLORS[0], items: [] }] : loopsSchema.parse(data.paths);
      revision.current = data.revision;
      let recovered = false;
      const raw = localStorage.getItem(journal.current);
      if (raw && !discardDraft) {
        try {
          const draft = JSON.parse(raw); const validated = loopsSchema.parse(draft.paths);
          if (JSON.stringify(validated) !== JSON.stringify(loopsSchema.parse(board))) {
            board = validated; recovered = true;
            if (draft.revision !== data.revision) {
              revision.current = draft.revision; setConflict(true);
              setError("Another tab has newer changes. Your unsaved board is kept here. Keep a copy before loading the saved version.");
            }
          }
        } catch { setBackupError("A previous browser backup could not be read. The saved board is shown."); }
      }
      latest.current = board; setPaths(board); pending.current = recovered;
      setCapturePath(current => board.some(p => p.id === current) ? current : (board.find(p => p.name.toLowerCase() === "inbox") ?? board[0]).id);
      setStatus(recovered ? "Recovered unsaved changes" : "All changes saved");
      if (!recovered) { localStorage.removeItem(journal.current); setConflict(false); }
      if (recovered && revision.current === data.revision) void flush();
    } catch (e) { setError((e as Error).message); setStatus("Unable to load"); }
  }
  useEffect(() => {
    if (!initialized.current) { initialized.current = true; void load(); }
    const guard = (event: BeforeUnloadEvent) => { if (pending.current || saving.current) event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => { window.removeEventListener("beforeunload", guard); };
  }, []);

  async function flush() {
    if (saving.current || !latest.current) return;
    saving.current = true; setError(""); setStatus("Saving…");
    try {
      while (pending.current) {
        pending.current = false;
        const response = await fetch("/api/loops", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: revision.current, paths: latest.current }) });
        const data = await response.json();
        if (!response.ok) { setConflict(response.status === 409); throw new Error(data.error || "Could not save Loops."); }
        revision.current = data.revision;
        if (pending.current) keepDraft(latest.current!);
      }
      try { localStorage.removeItem(journal.current); } catch { /* Server has the saved board. */ }
      setStatus("All changes saved"); setConflict(false);
    } catch (e) {
      pending.current = true; keepDraft(latest.current!);
      setStatus("Not synced · kept in this browser"); setError((e as Error).message);
    } finally { saving.current = false; }
  }
  function commit(next: LoopPath[]) {
    if (!loopsSchema.safeParse(next).success) { setError("That change is too large to save. Shorten the text or split it into more loops; your input is still here."); return false; }
    latest.current = next; setPaths(next); pending.current = true; keepDraft(next); setStatus("Saving…");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 350);
    return true;
  }
  function updatePath(id: string, patch: Partial<LoopPath>) { commit(latest.current!.map(p => p.id === id ? { ...p, ...patch } : p)); }
  function reorderPath(id: string, index: number) {
    const next = [...latest.current!]; const from = next.findIndex(p => p.id === id); if (from < 0) return;
    const [path] = next.splice(from, 1); next.splice(index, 0, path); commit(next);
  }
  function changeItem(id: string, patch: Partial<LoopItem>, move = "") {
    return commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id === id ? recordLoop({ ...item, ...patch }, item, move, people) : item) })));
  }
  function checkStep(id: string) {
    if (commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id === id ? completeNext(item, people) : item) })))) setFeedback({ text: "Step checked — the loop stays open." });
  }
  function resolve(id: string, resolved: boolean) {
    if (changeItem(id, { resolved })) setFeedback({ text: resolved ? "Checked. This loop stays right here." : "Loop reopened.", undoId: resolved ? id : undefined });
  }
  function capture(text: string, pathId: string) {
    const items = captureLoops(text); if (!items.length || !latest.current?.some(p => p.id === pathId)) return false;
    const saved = commit(latest.current.map(p => p.id === pathId ? { ...p, items: [...p.items, ...items] } : p));
    if (saved) { setFilter("all"); setFeedback({ text: `${items.length === 1 ? "Loop" : `${items.length} loops`} captured.` }); }
    return saved;
  }
  function drop(event: DragEvent, pathId: string, itemId?: string) {
    event.preventDefault(); event.stopPropagation(); if (!drag) return;
    if (drag.type === "path") reorderPath(drag.id, latest.current!.findIndex(p => p.id === pathId));
    else commit(moveItem(latest.current!, drag.id, pathId, itemId));
    setDrag(null); setOver("");
  }
  function startDrag(event: DragEvent, value: Drag) { setDrag(value); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", value.id); }
  function exportAndReload() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(latest.current, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "loops-unsaved-copy.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); void load(true);
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const openItems = paths?.flatMap(p => p.items).filter(i => !i.resolved) ?? [];
  const mine = openItems.filter(i => needsMyMove(i, today)).length;
  const matches = (item: LoopItem) => (filter === "all" || (filter === "me" ? item.ownerId === "me" || (!!item.review && item.review <= today) : item.state === "waiting"));

  return <section className="loops-workspace compact-loops">
    <div className="loops-heading"><div><div className="eyebrow">A LITTLE LESS ON YOUR MIND</div><h1>Loops<span className="loops-total">{openItems.length} open</span></h1><p>Get it out of your head. Pick up your next move.</p></div><button className="loops-quiet" disabled={!paths} onClick={() => setAddingPath(v => !v)}><Plus size={15} /> New path</button></div>
    <div className="loops-toolbar"><div className="loops-filters">{([ ["all", "Everything", openItems.length], ["me", "Needs me", mine], ["waiting", "Waiting", openItems.filter(i => i.state === "waiting").length] ] as const).map(([id, label, count]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}</div><span role="status">{status}</span></div>
    {filter === "me" && <p className="loops-filter-note">Your next moves, plus loops due for review.</p>}
    {(error || backupError) && <div className="loops-error" role="alert">{error || backupError}<button onClick={() => void (paths ? flush() : load())}>Retry</button>{conflict && <button onClick={exportAndReload}>Keep a copy &amp; refresh</button>}</div>}
    {feedback && <div className="loops-feedback" role="status"><Check size={14} />{feedback.text}{feedback.undoId && <button onClick={() => resolve(feedback.undoId!, false)}>Undo</button>}<button className="feedback-dismiss" aria-label="Dismiss update" onClick={() => setFeedback(null)}><X size={13} /></button></div>}
    {addingPath && <form className="loops-new-path-inline" onSubmit={e => { e.preventDefault(); if (!pathName.trim() || !latest.current) return; if (commit([...latest.current, { id: crypto.randomUUID(), name: pathName.trim(), color: PATH_COLORS[latest.current.length % PATH_COLORS.length], items: [] }])) { setPathName(""); setAddingPath(false); } }}><input autoFocus aria-label="New path name" placeholder="Name a path…" maxLength={100} value={pathName} onChange={e => setPathName(e.target.value)} /><button type="submit" disabled={!pathName.trim()}>Add path</button><button type="button" onClick={() => setAddingPath(false)}>Cancel</button></form>}
    <div className="loops-board">
      {paths?.map((path, index) => <section key={path.id} className={`loop-path ${over === path.id ? "drop-target" : ""}`} style={{ "--path-color": path.color } as CSSProperties} onDragOver={e => { if (drag) { e.preventDefault(); setOver(path.id); } }} onDrop={e => drop(e, path.id)}>
        <header className="loop-path-header"><button className="loop-grip" draggable onDragStart={e => startDrag(e, { type: "path", id: path.id })} onDragEnd={() => { setDrag(null); setOver(""); }} aria-label={`Drag ${path.name} path`}><GripVertical size={16} /></button><InlineText value={path.name} label={`Path name: ${path.name}`} maxLength={100} required onSave={name => updatePath(path.id, { name })} /><span>{path.items.filter(i => !i.resolved).length}</span><details className="loop-path-menu"><summary aria-label={`Options for ${path.name}`}><ChevronDown size={15} /></summary><div><small>Path color</small><div className="loop-swatches">{PATH_COLORS.map((color, i) => <button key={color} aria-label={`Color ${["violet", "green", "amber", "rose", "blue", "lilac"][i]}`} aria-pressed={path.color === color} style={{ background: color }} onClick={() => updatePath(path.id, { color })}>{path.color === color && <Check size={13} />}</button>)}</div><button disabled={index === 0} onClick={() => reorderPath(path.id, index - 1)}>Move path left</button><button disabled={index === paths.length - 1} onClick={() => reorderPath(path.id, index + 1)}>Move path right</button>{paths.length > 1 && path.items.length === 0 && <button onClick={() => { const next = latest.current!.filter(p => p.id !== path.id); if (commit(next) && capturePath === path.id) setCapturePath(next[0].id); }}>Remove empty path</button>}</div></details></header>
        <div className="loop-path-items">
          {path.items.filter(matches).map(item => <div key={item.id} className={over === item.id ? "drop-before" : ""} onDragOver={e => { if (drag?.type === "item") { e.preventDefault(); e.stopPropagation(); setOver(item.id); } }} onDrop={e => drop(e, path.id, item.id)}><LoopRow item={item} pathId={path.id} paths={paths} people={people} today={today} draftKey={`${draftPrefix}:${item.id}`} refreshPeople={refreshPeople} onChange={patch => changeItem(item.id, patch)} onLog={text => changeItem(item.id, {}, text)} onStep={() => checkStep(item.id)} onResolve={() => resolve(item.id, !item.resolved)} onMove={destination => commit(moveItem(latest.current!, item.id, destination))} onDragStart={e => startDrag(e, { type: "item", id: item.id })} onDragEnd={() => { setDrag(null); setOver(""); }} /></div>)}
          {!path.items.some(matches) && <p className="loop-empty-line">{filter === "all" ? "Nothing on your mind here. Yet." : filter === "me" ? "Nothing needs your push here." : "Nothing waiting here."}</p>}
          <QuickCapture key={`${draftPrefix}:${path.id}`} draftKey={`${draftPrefix}:${path.id}`} placeholder="+ Add a loop…" onCapture={text => capture(text, path.id)} />
        </div>
      </section>)}
      {paths && <button className="loop-new-path" onClick={() => setAddingPath(true)}><Plus size={18} /><span>New path</span></button>}
    </div>
    <p className="loops-hint">Checked loops and steps stay in place. Each loop’s trail is its next steps — check one and the next lights up.</p>
    {paths && <CaptureDock key={`${draftPrefix}:capture`} draftKey={`${draftPrefix}:capture`} paths={paths} pathId={capturePath} onPathChange={setCapturePath} onCapture={text => capture(text, capturePath)} />}
  </section>;
}

function CaptureDock({ draftKey, paths, pathId, onPathChange, onCapture }: { draftKey: string; paths: LoopPath[]; pathId: string; onPathChange: (id: string) => void; onCapture: (text: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(""); const [storageError, setStorageError] = useState(false);
  const container = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { try { setText(localStorage.getItem(`${draftKey}:input`) ?? ""); } catch { setStorageError(true); } }, [draftKey]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      // The path menu renders in a portal outside the dock.
      if (event.target instanceof Element && !container.current?.contains(event.target) && !event.target.closest(".select-positioner")) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);
  function change(value: string) { setText(value); try { if (value) localStorage.setItem(`${draftKey}:input`, value); else localStorage.removeItem(`${draftKey}:input`); } catch { setStorageError(true); } }
  function submit() { if (text.trim() && onCapture(text)) { change(""); input.current?.focus(); } }
  function close() { setOpen(false); trigger.current?.focus(); }
  const draft = text.trim().split(/\r?\n/)[0];
  return <div ref={container} className={`network-search loops-capture-dock ${open ? "is-open" : ""}`} onKeyDown={e => { if (e.key === "Escape" && !(e.target instanceof Element && e.target.closest(".select-positioner"))) { e.stopPropagation(); close(); } }}>
    <button ref={trigger} className="search-launcher" aria-expanded={open} aria-controls="loops-composer" onClick={() => setOpen(true)} tabIndex={open ? -1 : 0} aria-hidden={open}>
      <Plus size={16} /><span className="dock-label">{draft ? draft : "What’s on your mind?"}</span><kbd>{draft ? "Draft" : "Capture"}</kbd>
    </button>
    <form id="loops-composer" className="network-composer" inert={!open} aria-label="Quick capture loops" onSubmit={e => { e.preventDefault(); submit(); }}>
      <textarea ref={input} rows={2} aria-label="Quick capture loops" placeholder="What’s on your mind? Paste a list to capture several…" value={text} onChange={e => change(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      <div className="composer-bottom"><div className="loops-capture-destination"><span>Into</span><StyledSelect label="Capture into path" value={pathId} onChange={onPathChange} compact options={paths.map(p => ({ value: p.id, label: p.name, color: p.color }))} /><small role={storageError ? "alert" : undefined}>{storageError ? "Draft backup unavailable. Capture this before leaving." : "Enter to add · Shift+Enter for a new line"}</small></div><button className="composer-send" type="submit" disabled={!text.trim()} aria-label="Capture loops"><ArrowUp size={18} /></button></div>
    </form>
  </div>;
}

function InlineText({ value, label, onSave, placeholder, maxLength, required = false, multiline = false, autoFocus = false }: { value: string; label: string; onSave: (value: string) => void; placeholder?: string; maxLength: number; required?: boolean; multiline?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value); const focused = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <textarea ref={input} rows={1} className="loop-inline-text" aria-label={label} value={draft} placeholder={placeholder} maxLength={maxLength} onFocus={() => { focused.current = true; }} onChange={e => { setDraft(e.target.value); if (!required || e.target.value.trim()) onSave(e.target.value); }} onBlur={() => { focused.current = false; if (required && !draft.trim()) setDraft(value); else if (draft !== draft.trim()) { setDraft(draft.trim()); onSave(draft.trim()); } }} onKeyDown={e => { if (!multiline && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); } }} />;
}

function QuickCapture({ draftKey, placeholder, onCapture, label }: { draftKey: string; placeholder: string; onCapture: (text: string) => boolean; label?: string }) {
  const [text, setText] = useState(""); const [storageError, setStorageError] = useState(false); const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { try { setText(localStorage.getItem(`${draftKey}:input`) ?? ""); } catch { setStorageError(true); } }, [draftKey]);
  function change(value: string) { setText(value); try { if (value) localStorage.setItem(`${draftKey}:input`, value); else localStorage.removeItem(`${draftKey}:input`); } catch { setStorageError(true); } }
  function submit() { if (text.trim() && onCapture(text)) { change(""); input.current?.focus(); } }
  return <form className="loop-quick-capture" onSubmit={e => { e.preventDefault(); submit(); }}><textarea ref={input} aria-label={label ?? "Add loop in path"} rows={1} placeholder={placeholder} value={text} onChange={e => change(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><button type="submit" aria-label="Add" disabled={!text.trim()}><Plus size={15} /></button>{storageError && <small role="alert">Draft backup unavailable. Capture this before leaving.</small>}</form>;
}

function LoopRow({ item, pathId, paths, people, today, draftKey, refreshPeople, onChange, onLog, onStep, onResolve, onMove, onDragStart, onDragEnd }: { item: LoopItem; pathId: string; paths: LoopPath[]; people: ViewEntity[]; today: string; draftKey: string; refreshPeople: () => Promise<void>; onChange: (patch: Partial<LoopItem>) => boolean; onLog: (text: string) => boolean; onStep: () => void; onResolve: () => void; onMove: (path: string) => void; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }) {
  const due = !!item.review && item.review <= today;
  const activity = item.history.filter(h => h.event !== "move" && (h.event !== "updated" || h.text !== "Updated loop"));
  return <article className={`loop-row ${needsMyMove(item, today) ? "needs-me" : ""} ${item.resolved ? "is-checked" : ""}`}>
    <div className="loop-row-title"><input type="checkbox" checked={item.resolved} aria-label={`${item.resolved ? "Reopen" : "Resolve"} ${item.title}`} title="Check or reopen this loop" onChange={onResolve} /><InlineText value={item.title} label={`Loop title: ${item.title}`} required maxLength={200} onSave={title => onChange({ title })} /><button className="loop-grip" draggable aria-label={`Drag ${item.title}`} onDragStart={onDragStart} onDragEnd={onDragEnd}><GripVertical size={14} /></button></div>
    <div className="loop-row-meta"><StyledSelect label={`State for ${item.title}`} value={item.state} onChange={state => onChange({ state: state as LoopItem["state"] })} compact options={stateOptions} /><details className="loop-owner-menu"><summary>{item.ownerId === "me" ? "Your move" : item.ownerId ? ownerName(item, people) : "Assign"}<ChevronDown size={10} /></summary><div className="loop-owner-panel"><label>Next move<StyledSelect label={`Next owner for ${item.title}`} value={item.ownerId} onChange={ownerId => onChange({ ownerId })} options={[{ value: "me", label: "Me" }, { value: "", label: "Unassigned" }, ...item.people.map(p => ({ value: p.id, label: people.find(e => e.id === p.id)?.name ?? p.name }))]} /></label><PersonPicker people={people} attached={item.people} refreshPeople={refreshPeople} onAttach={person => onChange({ people: [...item.people, person], ownerId: person.id, state: "waiting" })} /><small>Pick or add someone to pass the next move to them.</small></div></details>{due && <span className="loop-due-dot" title={`Review due ${item.review}`}>Review due</span>}</div>
    <Trail item={item} draftKey={`${draftKey}:planned`} onChange={onChange} onStep={onStep} />
    <details className="loop-inline-details"><summary>Notes, people & review<ChevronDown size={11} /></summary><div className="loop-details-body"><label className="loop-field">Notes<InlineText value={item.context} label={`Notes for ${item.title}`} placeholder="Anything worth keeping…" multiline maxLength={4000} onSave={context => onChange({ context })} /></label><div className="loop-detail-meta"><label>Path<StyledSelect label={`Path for ${item.title}`} value={pathId} onChange={onMove} options={paths.map(p => ({ value: p.id, label: p.name, color: p.color }))} /></label><label>Review<input type="date" aria-label={`Review date for ${item.title}`} value={item.review} onChange={e => onChange({ review: e.target.value })} /></label></div><div className="loop-linked-people"><small>People</small><div className="loop-people-chips">{item.people.map(p => <span key={p.id}>{people.find(e => e.id === p.id)?.name ?? p.name}<button aria-label={`Detach ${p.name}`} onClick={() => onChange({ people: item.people.filter(x => x.id !== p.id), ownerId: item.ownerId === p.id ? "" : item.ownerId })}><X size={12} /></button></span>)}</div><PersonPicker people={people} attached={item.people} refreshPeople={refreshPeople} onAttach={person => onChange({ people: [...item.people, person] })} /></div><div className="loop-trail-heading">Log something that happened</div><QuickCapture draftKey={`${draftKey}:move`} placeholder="It goes on the trail as a done step…" onCapture={onLog} />{activity.length > 0 && <><div className="loop-trail-heading">Activity</div><ol className="loop-trail loop-activity">{activity.map(h => <li key={h.id}><p>{h.text}</p><time dateTime={h.at}>{formatWhen(h.at)}</time></li>)}</ol></>}</div></details>
  </article>;
}

const formatWhen = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Trail({ item, draftKey, onChange, onStep }: { item: LoopItem; draftKey: string; onChange: (patch: Partial<LoopItem>) => boolean; onStep: () => void }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const moves = item.history.filter(h => h.event === "move");
  const shownMoves = showEarlier ? moves : moves.slice(-1);
  const steps = item.steps ?? [];
  const currentId = item.next ? "next" : steps.find(s => !s.done)?.id;
  if (!moves.length && !item.next && !steps.length && item.resolved) return null;
  return <ol className="loop-trail connected-trail loop-step-trail">
    {moves.length > 1 && <li className="trail-earlier"><span className="loop-trail-mark"><span className="trail-node" /></span><button onClick={() => setShowEarlier(v => !v)}>{showEarlier ? "Hide earlier steps" : `${moves.length - 1} earlier ${moves.length === 2 ? "step" : "steps"}`}</button></li>}
    {shownMoves.map(h => <li key={h.id} className="trail-step trail-done"><span className="loop-trail-mark"><input type="checkbox" checked readOnly disabled aria-label={`Done: ${h.text}`} /></span><div><p title={formatWhen(h.at)}>{h.text}</p></div></li>)}
    {item.next && <li className="trail-step trail-current"><span className="loop-trail-mark"><input type="checkbox" checked={false} disabled={item.resolved} aria-label={`Check step: ${item.next}`} title="Check this step; the loop stays open" onChange={onStep} /></span><div><InlineText value={item.next} label={`Edit step: ${item.next}`} maxLength={2000} onSave={next => onChange({ next })} /></div></li>}
    {steps.map(step => <li key={step.id} className={`trail-step ${step.done ? "trail-done" : ""} ${step.id === currentId ? "trail-current" : ""}`}><span className="loop-trail-mark"><input type="checkbox" checked={step.done} aria-label={`${step.done ? "Uncheck" : "Check"} step: ${step.text}`} title={step.completedAt ? `Done ${formatWhen(step.completedAt)}` : "Check this step; the loop stays open"} onChange={e => onChange({ steps: toggleStep(item, step.id, e.target.checked).steps })} /></span><div><InlineText value={step.text} label={`Edit step: ${step.text}`} maxLength={2000} required onSave={text => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, text } : s) })} /></div></li>)}
    {!item.resolved && <li className="trail-add"><span className="loop-trail-mark"><Plus size={11} /></span><QuickCapture draftKey={draftKey} placeholder={currentId ? "Then…" : "Next step…"} label={`Add a step to ${item.title}`} onCapture={text => onChange({ steps: planSteps(item, text).steps })} /></li>}
  </ol>;
}
