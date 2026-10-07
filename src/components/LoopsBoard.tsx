"use client";

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { AlignLeft, ArrowUp, Check, CheckCheck, ChevronDown, Ellipsis, GripVertical, Pencil, Plus, Sparkles, Trash2, UserPlus, X } from "lucide-react";
import { LoopsLayout } from "./LoopsLayout";
import { PersonPicker } from "./LoopPersonPicker";
import { StyledSelect } from "./ui/select";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { LOOP_STATES, PATH_COLORS, PATH_PALETTE, pathDisplayColor, captureLoops, completeNext, loopsSchema, moveItem, needsMyMove, ownerName, recordLoop, planSteps, toggleStep, type LoopItem, type LoopPath, type LoopPerson } from "@/lib/loops";
import type { ViewEntity } from "@/lib/view-model";

type Drag = { type: "path" | "item"; id: string };
type Filter = "all" | "me" | "waiting" | "done";
const CAPTURED_ONE = ["Out of your head, onto the board.", "Captured. One less thing to hold.", "Got it — it’s on the board now.", "Loop opened. Your head just got lighter."];
const ADD_PROMPTS = ["What’s still open?", "Who are you waiting on?", "A reply you owe someone…", "Something to follow up on…", "What’s nagging at you?", "What did you promise someone?"];
const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];
const stateOptions = Object.entries(LOOP_STATES).map(([value, label], index) => ({ value, label, color: ["#36866b", "#c39330", "#8b63bd", "#3986bd"][index] }));

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
  const [layoutKey, setLayoutKey] = useState("");
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
  const [feedback, setFeedback] = useState<{ text: string; undo?: () => void } | null>(null);
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const people = entities.filter(e => e.type === "person");
  useEffect(() => { if (!fresh.size) return; const t = setTimeout(() => setFresh(new Set()), 1800); return () => clearTimeout(t); }, [fresh]);

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
      setLayoutKey(`waze-loops-layout:${data.workspaceId}`);
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
  function deletePath(id: string, confirmed = false) {
    const board = latest.current!; const index = board.findIndex(p => p.id === id); const path = board[index];
    if (!path || board.length < 2) return;
    if (path.items.length && !confirmed) { setConfirmDelete(id); return; }
    setConfirmDelete(null);
    const next = board.filter(p => p.id !== id);
    if (!commit(next)) return;
    if (capturePath === id) setCapturePath(next[0].id);
    setFeedback({ text: `Deleted “${path.name}”.`, undo: () => { const restored = [...latest.current!]; restored.splice(Math.min(index, restored.length), 0, path); commit(restored); } });
  }
  function changeItem(id: string, patch: Partial<LoopItem>, move = "") {
    return commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id === id ? recordLoop({ ...item, ...patch }, item, move, people) : item) })));
  }
  function checkStep(id: string) {
    if (commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id === id ? completeNext(item, people) : item) })))) setFeedback({ text: "Step checked — the loop stays open." });
  }
  function removeStep(id: string, stepId: string) {
    commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id !== id ? item : stepId === "next" ? { ...item, next: "" } : { ...item, steps: (item.steps ?? []).filter(s => s.id !== stepId), history: item.history.filter(h => h.event !== "move" || h.id !== stepId) }) })));
  }
  function deleteItem(id: string) {
    const board = latest.current!; const pathIndex = board.findIndex(p => p.items.some(i => i.id === id)); if (pathIndex < 0) return;
    const { id: pathId, items } = board[pathIndex]; const index = items.findIndex(i => i.id === id); const item = items[index];
    if (!commit(board.map(p => p.id === pathId ? { ...p, items: p.items.filter(i => i.id !== id) } : p))) return;
    setFeedback({ text: `Deleted “${item.title}”.`, undo: () => commit(latest.current!.map(p => p.id === pathId ? { ...p, items: [...p.items.slice(0, index), item, ...p.items.slice(index)] } : p)) });
  }
  function setCleared(ids: Set<string>, clearedAt: string | null) {
    return commit(latest.current!.map(p => ({ ...p, items: p.items.map(i => ids.has(i.id) ? { ...i, clearedAt } : i) })));
  }
  /** Cleared loops leave the board but stay in Done. */
  function clearLoops(items: LoopItem[]) {
    const ids = new Set(items.map(i => i.id)); if (!ids.size || !setCleared(ids, new Date().toISOString())) return;
    setFeedback({ text: items.length === 1 ? `Moved “${items[0].title}” to Done.` : `Moved ${items.length} loops to Done.`, undo: () => setCleared(ids, null) });
  }
  const checkedOnBoard = (path: LoopPath) => path.items.filter(i => i.resolved && !i.clearedAt);
  function resolve(id: string, resolved: boolean) {
    if (changeItem(id, resolved ? { resolved } : { resolved, clearedAt: null })) setFeedback({ text: resolved ? "Checked. This loop stays right here." : "Loop reopened and back on the board.", undo: resolved ? () => resolve(id, false) : undefined });
  }
  function capture(text: string, pathId: string) {
    const items = captureLoops(text); if (!items.length || !latest.current?.some(p => p.id === pathId)) return false;
    const saved = commit(latest.current.map(p => p.id === pathId ? { ...p, items: [...p.items, ...items] } : p));
    if (saved) {
      setFilter("all"); setFresh(new Set(items.map(i => i.id)));
      setFeedback({ text: items.length === 1 ? pick(CAPTURED_ONE) : `${items.length} loops captured. Head cleared.` });
    }
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
    <div className="loops-heading"><div><h1>Loops<span className="loops-total">{openItems.length} open</span></h1></div><button className="loops-quiet" disabled={!paths} onClick={() => setAddingPath(v => !v)}><Plus size={15} /> New path</button></div>
    <div className="loops-toolbar"><div className="loops-filters">{([ ["all", "Everything", openItems.length], ["me", "Needs me", mine], ["waiting", "Waiting", openItems.filter(i => i.state === "waiting").length], ["done", "Done", paths?.flatMap(p => p.items).filter(i => i.clearedAt).length ?? 0] ] as const).map(([id, label, count]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{count}</span></button>)}</div><span role="status">{status}</span></div>
    {filter === "me" && <p className="loops-filter-note">Your next moves, plus loops due for review.</p>}
    {filter === "done" && <p className="loops-filter-note">Everything you’ve cleared off the board. Uncheck a loop to bring it back.</p>}
    {(error || backupError) && <div className="loops-error" role="alert">{error || backupError}<button onClick={() => void (paths ? flush() : load())}>Retry</button>{conflict && <button onClick={exportAndReload}>Keep a copy &amp; refresh</button>}</div>}
    {feedback && <div key={feedback.text} className="loops-feedback" role="status"><Check size={14} />{feedback.text}{feedback.undo && <button onClick={() => { feedback.undo!(); setFeedback(null); }}>Undo</button>}<button className="feedback-dismiss" aria-label="Dismiss update" onClick={() => setFeedback(null)}><X size={13} /></button></div>}
    {addingPath && <form className="loops-new-path-inline" onSubmit={e => { e.preventDefault(); if (!pathName.trim() || !latest.current) return; if (commit([...latest.current, { id: crypto.randomUUID(), name: pathName.trim(), color: PATH_COLORS[latest.current.length % PATH_COLORS.length], items: [] }])) { setPathName(""); setAddingPath(false); } }}><input autoFocus aria-label="New path name" placeholder="Name a path…" maxLength={100} value={pathName} onChange={e => setPathName(e.target.value)} /><button type="submit" disabled={!pathName.trim()}>Add path</button><button type="button" onClick={() => setAddingPath(false)}>Cancel</button></form>}
    {paths && <LoopsLayout key={layoutKey} paths={paths} storageKey={layoutKey} onChange={commit} previewMatches={item => filter === "done" ? !!item.clearedAt : !item.resolved && !item.clearedAt && matches(item)}>
      {(path, index, organize) => <section key={path.id} className={`loop-path ${over === path.id ? "drop-target" : ""}`} style={{ "--path-color": pathDisplayColor(path.color) } as CSSProperties} onDragOver={e => { if (drag) { e.preventDefault(); setOver(path.id); } }} onDrop={e => drop(e, path.id)}>
        <header className="loop-path-header"><button className="loop-grip" draggable onDragStart={e => startDrag(e, { type: "path", id: path.id })} onDragEnd={() => { setDrag(null); setOver(""); }} aria-label={`Drag ${path.name} path`}><GripVertical size={16} /></button><InlineText value={path.name} label={`Path name: ${path.name}`} maxLength={100} required onSave={name => updatePath(path.id, { name })} /><span>{path.items.filter(i => !i.resolved).length}</span><Menu className="loop-path-menu"><summary aria-label={`Options for ${path.name}`}><ChevronDown size={15} /></summary><div><button onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); organize(); }}>{path.stack ? "Change stack…" : "Move to stack…"}</button><small>Path color</small><div className="loop-swatches" role="group" aria-label="Board color">{PATH_PALETTE.map(({ color, name }) => <button key={color} aria-label={`Color ${name}`} title={name} aria-pressed={pathDisplayColor(path.color) === color} style={{ background: color }} onClick={() => updatePath(path.id, { color })}>{pathDisplayColor(path.color) === color && <Check size={13} />}</button>)}</div>{checkedOnBoard(path).length > 0 && <button onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); clearLoops(checkedOnBoard(path)); }}>Move {checkedOnBoard(path).length} checked to Done</button>}<button disabled={index === 0} onClick={() => reorderPath(path.id, index - 1)}>Move path left</button><button disabled={index === paths!.length - 1} onClick={() => reorderPath(path.id, index + 1)}>Move path right</button>{paths!.length > 1 && <button className="loop-path-delete" onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); deletePath(path.id); }}>Delete path</button>}</div></Menu></header>
        <div className="loop-path-items" tabIndex={0} role="region" aria-label={`${path.name} loops`}><div className="loop-path-content">
          {filter === "done" ? (() => { const done = path.items.filter(i => i.clearedAt).sort((a, b) => b.clearedAt!.localeCompare(a.clearedAt!)); return done.length
            ? <div className="loop-done-list">{done.map(item => <div key={item.id} className="loop-resolved-row loop-done-row"><input type="checkbox" checked aria-label={`Reopen ${item.title}`} title="Reopen and put back on the board" onChange={() => resolve(item.id, false)} /><span>{item.title}</span><time dateTime={item.clearedAt!} title={`Cleared ${formatWhen(item.clearedAt!)}`}>{formatDay(item.clearedAt!)}</time><button className="loop-clear-small" aria-label={`Delete ${item.title} for good`} title="Delete for good" onClick={() => deleteItem(item.id)}><Trash2 size={12} /></button></div>)}</div>
            : <p className="loop-empty-line">Nothing cleared here yet.</p>; })() : <>
          {(() => { const shown = path.items.filter(i => !i.clearedAt && matches(i)); const folded = foldedDone(shown); return <>
          {folded.size > 0 && <div className="loop-earlier-done"><div className="loop-earlier-done-bar"><button aria-expanded={!!showDone[path.id]} onClick={() => setShowDone(v => ({ ...v, [path.id]: !v[path.id] }))}><ChevronDown size={11} />{showDone[path.id] ? "Hide earlier done" : `${folded.size} earlier done`}</button><button className="loop-clear-all" onClick={() => clearLoops(checkedOnBoard(path))}>Move all to Done</button></div>{showDone[path.id] && shown.filter(item => folded.has(item.id)).map(item => <div key={item.id} className="loop-resolved-row"><input type="checkbox" checked aria-label={`Reopen ${item.title}`} title="Reopen this loop" onChange={() => resolve(item.id, false)} /><span>{item.title}</span><button className="loop-clear-small" aria-label={`Move ${item.title} to Done`} title="Move to Done" onClick={() => clearLoops([item])}><CheckCheck size={12} /></button></div>)}</div>}
          {shown.filter(item => !folded.has(item.id)).map(item => <div key={item.id} className={over === item.id ? "drop-before" : ""} onDragOver={e => { if (drag?.type === "item") { e.preventDefault(); e.stopPropagation(); setOver(item.id); } }} onDrop={e => drop(e, path.id, item.id)}><LoopRow item={item} fresh={fresh.has(item.id)} pathId={path.id} paths={paths!} people={people} today={today} draftKey={`${draftPrefix}:${item.id}`} refreshPeople={refreshPeople} onChange={patch => changeItem(item.id, patch)} onLog={text => changeItem(item.id, {}, text)} onStep={() => checkStep(item.id)} onRemoveStep={stepId => removeStep(item.id, stepId)} onResolve={() => resolve(item.id, !item.resolved)} onDelete={() => deleteItem(item.id)} onClear={() => clearLoops([item])} onMove={destination => commit(moveItem(latest.current!, item.id, destination))} onDragStart={e => startDrag(e, { type: "item", id: item.id })} onDragEnd={() => { setDrag(null); setOver(""); }} /></div>)}
          </>; })()}
          {!path.items.some(i => !i.clearedAt && matches(i)) && <p className="loop-empty-line">{filter === "all" ? "Nothing on your mind here. Yet." : filter === "me" ? "Nothing needs your push here." : "Nothing waiting here."}</p>}
          <QuickCapture key={`${draftPrefix}:${path.id}`} draftKey={`${draftPrefix}:${path.id}`} placeholder="+ Add a loop…" prompts={ADD_PROMPTS} captureOnBlur onCapture={text => capture(text, path.id)} />
          </>}
        </div></div>
      </section>}
    </LoopsLayout>}
    {paths && <CaptureDock key={`${draftPrefix}:capture`} draftKey={`${draftPrefix}:capture`} paths={paths} pathId={capturePath} onPathChange={setCapturePath} onCapture={text => capture(text, capturePath)} />}
    {(() => { const target = paths?.find(p => p.id === confirmDelete); const count = target?.items.length ?? 0; return <Dialog open={!!target} onOpenChange={open => { if (!open) setConfirmDelete(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Delete “{target?.name}”?</DialogTitle><DialogDescription>This path and its {count === 1 ? "loop" : `${count} loops`} will be removed. You can undo right after.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="destructive" autoFocus onClick={() => target && deletePath(target.id, true)}>Delete path</Button></DialogFooter>
      </DialogContent>
    </Dialog>; })()}
  </section>;
}

/** Checked loops beyond the most recent few fold away, oldest first. */
function foldedDone(items: LoopItem[]) {
  const resolvedAt = (item: LoopItem) => item.history.filter(h => h.event === "resolved").at(-1)?.at ?? "";
  return new Set(items.filter(i => i.resolved).sort((a, b) => resolvedAt(b).localeCompare(resolvedAt(a))).slice(RECENT_DONE).map(i => i.id));
}

type DockMode = "capture" | "ask";

function CaptureDock({ draftKey, paths, pathId, onPathChange, onCapture }: { draftKey: string; paths: LoopPath[]; pathId: string; onPathChange: (id: string) => void; onCapture: (text: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DockMode>("capture");
  const [scope, setScope] = useState("all");
  const [asked, setAsked] = useState(false);
  const [text, setText] = useState(""); const [storageError, setStorageError] = useState(false);
  const container = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { try { setText(localStorage.getItem(`${draftKey}:input`) ?? ""); } catch { setStorageError(true); } }, [draftKey]);
  useEffect(() => {
    if (!open) return;
    let frame = 0; let tries = 0;
    // The composer can still be computed as hidden for a frame while it expands.
    const focus = () => {
      const el = input.current; if (!el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
      else if (tries++ < 20) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [open]);
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
  function submit() {
    if (!text.trim()) return;
    if (mode === "ask") { setAsked(true); return; }
    if (onCapture(text)) { change(""); input.current?.focus(); }
  }
  function switchMode(next: DockMode) { setMode(next); setAsked(false); input.current?.focus(); }
  function close() { setOpen(false); if (mode === "ask" && !text.trim()) setMode("capture"); trigger.current?.focus(); }
  const draft = text.trim().split(/\r?\n/)[0];
  const looksLikeQuestion = mode === "capture" && !text.trim().includes("\n") && (/\?\s*$/.test(text) || /^(who|what|when|where|why|how|which)\b/i.test(text.trim()));
  const hint = storageError ? "Draft backup unavailable. Capture this before leaving."
    : asked ? "Asking your loops is coming soon. Your question stays here."
    : looksLikeQuestion ? "Looks like a question — Ask instead? Ctrl+/"
    : mode === "ask" ? "Ask about what’s open, waiting or stuck" : "Enter to add · Shift+Enter for a new line";
  return <div ref={container} className={`network-search loops-capture-dock ${open ? "is-open" : ""}`} onKeyDown={e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); switchMode(mode === "capture" ? "ask" : "capture"); }
    else if (e.key === "Escape" && !(e.target instanceof Element && e.target.closest(".select-positioner"))) { e.stopPropagation(); close(); }
  }}>
    <button ref={trigger} className="search-launcher" aria-expanded={open} aria-controls="loops-composer" onClick={() => setOpen(true)} tabIndex={open ? -1 : 0} aria-hidden={open}>
      {mode === "ask" ? <Sparkles size={16} /> : <Plus size={16} />}<span className="dock-label">{draft || (mode === "ask" ? "Ask your loops" : "What’s on your mind?")}</span><kbd>{draft ? "Draft" : mode === "ask" ? "Ask" : "Capture"}</kbd>
    </button>
    <form id="loops-composer" className="network-composer" inert={!open} aria-label={mode === "ask" ? "Ask your loops" : "Quick capture loops"} onSubmit={e => { e.preventDefault(); submit(); }}>
      <textarea ref={input} rows={2} aria-label={mode === "ask" ? "Ask a question about your loops" : "Quick capture loops"} placeholder={mode === "ask" ? "What’s waiting on Roy?" : "What’s on your mind? Paste a list to capture several…"} value={text} onChange={e => { change(e.target.value); setAsked(false); }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      <div className="composer-bottom">
        <div className="loops-capture-destination">
          <div className="dock-modes" role="group" aria-label="Composer mode">{(["capture", "ask"] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => switchMode(m)}>{m === "ask" ? <Sparkles size={11} /> : <Plus size={11} />}{m === "ask" ? "Ask" : "Capture"}</button>)}</div>
          {mode === "capture"
            ? <><span>Into</span><StyledSelect label="Capture into path" value={pathId} onChange={onPathChange} compact options={paths.map(p => ({ value: p.id, label: p.name, color: pathDisplayColor(p.color) }))} /></>
            : <StyledSelect label="Ask across" value={scope} onChange={setScope} compact options={[{ value: "all", label: "All paths" }, { value: "me", label: "Needs me" }, ...paths.map(p => ({ value: p.id, label: p.name, color: pathDisplayColor(p.color) }))]} />}
          <small role={storageError || asked ? "status" : undefined}>{hint}</small>
        </div>
        <button className="composer-send" type="submit" disabled={!text.trim()} aria-label={mode === "ask" ? "Ask your loops" : "Capture loops"}><ArrowUp size={18} /></button>
      </div>
    </form>
  </div>;
}

function InlineText({ value, label, onSave, placeholder, maxLength, required = false, multiline = false, autoFocus = false }: { value: string; label: string; onSave: (value: string) => void; placeholder?: string; maxLength: number; required?: boolean; multiline?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value); const focused = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return <textarea ref={input} rows={1} className="loop-inline-text" aria-label={label} value={draft} placeholder={placeholder} maxLength={maxLength} onFocus={() => { focused.current = true; }} onChange={e => { setDraft(e.target.value); if (!required || e.target.value.trim()) onSave(e.target.value); }} onBlur={() => { focused.current = false; if (required && !draft.trim()) setDraft(value); else if (draft !== draft.trim()) { setDraft(draft.trim()); onSave(draft.trim()); } }} onKeyDown={e => { if (!multiline && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); } }} />;
}

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

/** Renders plain text with bare URLs and `[label](url)` links made clickable. */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = []; let last = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index; let raw = match[0]; let href = match[2]; let label = match[1];
    if (!href) {
      while (/[.,;:!?'"\]]$/.test(raw) || (raw.endsWith(")") && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0))) raw = raw.slice(0, -1);
      href = /^www\./i.test(raw) ? `https://${raw}` : raw;
      label = raw.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
    }
    parts.push(text.slice(last, start), <a key={start} href={href} target="_blank" rel="noopener noreferrer" title={href} onClick={e => e.stopPropagation()}>{label}</a>);
    last = start + raw.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

const notesPreview = (text: string) => text.replace(LINK, (match, label: string | undefined) => label ?? match.replace(/^https?:\/\/(www\.)?/i, "")).trim();

/** Notes read as text with clickable links; clicking the text (not a link) switches to editing. */
function NotesBody({ value, label, autoEdit = false, onSave, onDone }: { value: string; label: string; autoEdit?: boolean; onSave: (value: string) => void; onDone?: (value: string) => void }) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { const el = input.current; if (editing && el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  function finish() { const text = draft.trim(); if (text !== draft) onSave(text); setEditing(false); onDone?.(text); }
  if (editing) return <textarea ref={input} className="loop-notes-input" aria-label={label} value={draft} placeholder="Add notes, links, anything worth keeping…" maxLength={4000} onChange={e => { setDraft(e.target.value); onSave(e.target.value); }} onBlur={finish} onKeyDown={e => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }} />;
  if (!value.trim()) return <button type="button" className="loop-notes-empty" onClick={() => setEditing(true)}>Add notes, links, anything worth keeping…</button>;
  return <div className="loop-notes-view">
    <div className="loop-notes-text" onClick={() => { if (!window.getSelection()?.toString()) setEditing(true); }}><Linkified text={value} /></div>
    <button type="button" className="loop-notes-edit" aria-label={`Edit ${label}`} title="Edit notes" onClick={() => setEditing(true)}><Pencil size={12} /></button>
  </div>;
}

function QuickCapture({ autoFocus = false, draftKey, placeholder, prompts, onCapture, label, captureOnBlur = false }: { autoFocus?: boolean; draftKey: string; placeholder: string; prompts?: string[]; onCapture: (text: string) => boolean; label?: string; captureOnBlur?: boolean }) {
  const [text, setText] = useState(""); const [storageError, setStorageError] = useState(false); const input = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  useEffect(() => { try { setText(localStorage.getItem(`${draftKey}:input`) ?? ""); } catch { setStorageError(true); } }, [draftKey]);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  function change(value: string) { setText(value); try { if (value) localStorage.setItem(`${draftKey}:input`, value); else localStorage.removeItem(`${draftKey}:input`); } catch { setStorageError(true); } }
  function submit() { if (text.trim() && onCapture(text)) { change(""); if (prompts) setPrompt(pick(prompts)); input.current?.focus(); } }
  return <form className="loop-quick-capture" onSubmit={e => { e.preventDefault(); submit(); }}><textarea ref={input} aria-label={label ?? "Add loop in path"} rows={1} placeholder={prompt || placeholder} value={text} onChange={e => change(e.target.value)} onFocus={() => { if (prompts) setPrompt(pick(prompts)); }} onBlur={() => { setPrompt(""); if (captureOnBlur && document.hasFocus() && text.trim() && onCapture(text)) change(""); }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><button type="submit" aria-label="Add" disabled={!text.trim()}><Plus size={15} /></button>{storageError && <small role="alert">Draft backup unavailable. Capture this before leaving.</small>}</form>;
}

function LoopRow({ item, fresh, pathId, paths, people, today, draftKey, refreshPeople, onChange, onLog, onStep, onRemoveStep, onResolve, onDelete, onClear, onMove, onDragStart, onDragEnd }: { item: LoopItem; fresh: boolean; pathId: string; paths: LoopPath[]; people: ViewEntity[]; today: string; draftKey: string; refreshPeople: () => Promise<void>; onChange: (patch: Partial<LoopItem>) => boolean; onLog: (text: string) => boolean; onStep: () => void; onRemoveStep: (stepId: string) => void; onResolve: () => void; onDelete: () => void; onClear: () => void; onMove: (path: string) => void; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const hasNotes = !!item.context.trim();
  const due = !!item.review && item.review <= today;
  const activity = item.history.filter(h => h.event !== "move" && (h.event !== "updated" || h.text !== "Updated loop"));
  const row = useRef<HTMLElement>(null);
  useEffect(() => {
    if (fresh) row.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [fresh]);
  return <article ref={row} className={`loop-row ${needsMyMove(item, today) ? "needs-me" : ""} ${item.resolved ? "is-checked" : ""} ${fresh ? "is-new" : ""} ${leaving ? "is-leaving" : ""}`}>
    <div className="loop-row-title"><button className="loop-grip" draggable aria-label={`Drag ${item.title}`} onDragStart={onDragStart} onDragEnd={onDragEnd}><GripVertical size={14} /></button><input type="checkbox" checked={item.resolved} aria-label={`${item.resolved ? "Reopen" : "Resolve"} ${item.title}`} title="Check or reopen this loop" onChange={onResolve} /><InlineText value={item.title} label={`Loop title: ${item.title}`} required maxLength={200} onSave={title => onChange({ title })} />{item.resolved && <button className="loop-clear" aria-label={`Move ${item.title} to Done`} title="Move off the board into Done" onClick={() => { setLeaving(true); setTimeout(onClear, 200); }}><CheckCheck size={13} />Clear</button>}<button className={`loop-row-action loop-notes-toggle ${hasNotes ? "has-notes" : ""}`} aria-expanded={notesOpen} aria-label={`${notesOpen ? "Hide" : hasNotes ? "Show" : "Add"} notes for ${item.title}`} title={notesOpen ? "Hide notes" : hasNotes ? "Show notes" : "Add notes"} onClick={() => setNotesOpen(v => !v)}><AlignLeft size={15} /></button><button className="loop-row-action" aria-label={`Edit ${item.title}`} title="Edit loop" onClick={() => setEditing(true)}><Ellipsis size={17} /></button></div>
    {notesOpen ? <div className="loop-notes"><NotesBody value={item.context} label={`Notes for ${item.title}`} autoEdit={!hasNotes} onSave={context => onChange({ context })} onDone={text => { if (!text) setNotesOpen(false); }} /></div>
      : hasNotes && <button className="loop-notes-preview" title="Show notes" onClick={() => setNotesOpen(true)}><AlignLeft size={12} /><span>{notesPreview(item.context)}</span></button>}
    {!item.resolved && (item.state !== "action" || (item.ownerId && item.ownerId !== "me") || due) && <button className="loop-exception" onClick={() => setEditing(true)}>{item.state !== "action" && <><span className="loop-status-dot" style={{ background: stateOptions.find(s => s.value === item.state)?.color }} />{LOOP_STATES[item.state]}</>}{item.ownerId && item.ownerId !== "me" && <span>{ownerName(item, people)}</span>}{due && <span className="loop-due-dot">Review due</span>}</button>}
    <Trail item={item} people={people} refreshPeople={refreshPeople} draftKey={`${draftKey}:planned`} onChange={onChange} onStep={onStep} onRemove={onRemoveStep} />
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent className="loops-loop-editor"><DialogHeader><DialogTitle>{item.title}</DialogTitle><DialogDescription>State, ownership, notes and activity.</DialogDescription></DialogHeader><div className="loop-editor-meta"><StyledSelect label={`State for ${item.title}`} value={item.state} onChange={state => onChange({ state: state as LoopItem["state"] })} compact options={stateOptions} /><Menu className="loop-owner-menu"><summary>{item.ownerId === "me" ? "Your move" : item.ownerId ? ownerName(item, people) : "Assign"}<ChevronDown size={10} /></summary><div className="loop-owner-panel"><label>Next move<StyledSelect label={`Next owner for ${item.title}`} value={item.ownerId} onChange={ownerId => onChange({ ownerId })} options={[{ value: "me", label: "Me" }, { value: "", label: "Unassigned" }, ...item.people.map(p => ({ value: p.id, label: people.find(e => e.id === p.id)?.name ?? p.name }))]} /></label><PersonPicker people={people} attached={item.people} refreshPeople={refreshPeople} onAttach={person => onChange({ people: [...item.people, person], ownerId: person.id, state: "waiting" })} /><small>Pick or add someone to pass the next move to them.</small></div></Menu>{due && <span className="loop-due-dot" title={`Review due ${item.review}`}>Review due</span>}</div><div className="loop-details-body"><div className="loop-field"><small>Notes</small><NotesBody value={item.context} label={`Notes for ${item.title}`} onSave={context => onChange({ context })} /></div><div className="loop-detail-meta"><label>Path<StyledSelect label={`Path for ${item.title}`} value={pathId} onChange={onMove} options={paths.map(p => ({ value: p.id, label: p.name, color: pathDisplayColor(p.color) }))} /></label><label>Review<input type="date" aria-label={`Review date for ${item.title}`} value={item.review} onChange={e => onChange({ review: e.target.value })} /></label></div><div className="loop-linked-people"><small>People</small><div className="loop-people-chips">{item.people.map(p => <span key={p.id}>{people.find(e => e.id === p.id)?.name ?? p.name}<button aria-label={`Detach ${p.name}`} onClick={() => onChange({ people: item.people.filter(x => x.id !== p.id), ownerId: item.ownerId === p.id ? "" : item.ownerId })}><X size={12} /></button></span>)}</div><PersonPicker people={people} attached={item.people} refreshPeople={refreshPeople} onAttach={person => onChange({ people: [...item.people, person] })} /></div><div className="loop-trail-heading">Log something that happened</div><QuickCapture draftKey={`${draftKey}:move`} placeholder="It goes on the trail as a done step…" onCapture={onLog} />{activity.length > 0 && <><div className="loop-trail-heading">Activity</div><ol className="loop-trail loop-activity">{activity.map(h => <li key={h.id}><p>{h.text}</p><time dateTime={h.at}>{formatWhen(h.at)}</time></li>)}</ol></>}</div><DialogFooter><Button variant="destructive" onClick={() => { setEditing(false); onDelete(); }}><Trash2 size={14} />Delete loop</Button></DialogFooter></DialogContent></Dialog>
  </article>;
}

type Step = NonNullable<LoopItem["steps"]>[number];

function StepPeople({ step, people, refreshPeople, onAttach, onDetach }: { step: Step; people: ViewEntity[]; refreshPeople: () => Promise<void>; onAttach: (person: LoopPerson) => void; onDetach: (id: string) => void }) {
  return <Menu className="trail-person-menu">
    <summary aria-label={`Attach a person to step: ${step.text}`} title="Attach a person"><UserPlus size={13} /></summary>
    <div className="trail-person-panel">
      {step.people.length > 0 && <div className="loop-people-chips">{step.people.map(p => { const name = people.find(e => e.id === p.id)?.name ?? p.name; return <span key={p.id}>{name}<button type="button" aria-label={`Detach ${name} from step`} onClick={() => onDetach(p.id)}><X size={12} /></button></span>; })}</div>}
      <PersonPicker people={people} attached={step.people} refreshPeople={refreshPeople} onAttach={onAttach} />
    </div>
  </Menu>;
}

/** A `<details>` popover that closes on an outside click, outside focus or Escape. */
function Menu({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => { if (ref.current) ref.current.open = false; };
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      // Select menus render in a portal outside the panel that opened them.
      if (target instanceof Element && target.closest(".select-positioner")) return;
      close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <details ref={ref} className={className} onToggle={e => setOpen(e.currentTarget.open)}>{children}</details>;
}

const RECENT_DONE = 3;
const formatDay = (at: string) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const formatWhen = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Trail({ item, people, refreshPeople, draftKey, onChange, onStep, onRemove }: { item: LoopItem; people: ViewEntity[]; refreshPeople: () => Promise<void>; draftKey: string; onChange: (patch: Partial<LoopItem>) => boolean; onStep: () => void; onRemove: (stepId: string) => void }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const toggleNotes = (id: string, open: boolean) => setOpenNotes(v => ({ ...v, [id]: open }));
  const moves = item.history.filter(h => h.event === "move");
  const steps = item.steps ?? [];
  type Step = (typeof steps)[number];
  const open = steps.filter(s => !s.done);
  const currentId = item.next ? "next" : open[0]?.id;
  type Entry = { move?: (typeof moves)[number]; step?: Step; next?: true };
  const entries: Entry[] = [...moves.map(move => ({ move })), ...steps.map(step => ({ step }))];
  if (item.next) { const at = entries.findIndex(e => e.step && !e.step.done); entries.splice(at < 0 ? entries.length : at, 0, { next: true }); }
  const leadingDone = entries.findIndex(e => e.next || (e.step && !e.step.done));
  const earlier = Math.max(0, (leadingDone < 0 ? entries.length : leadingDone) - RECENT_DONE);
  const remove = (id: string, text: string) => <button type="button" className="trail-remove" aria-label={`Delete step: ${text}`} title="Delete step" onClick={() => onRemove(id)}><Trash2 size={13} /></button>;
  const stepRow = (step: Step) => <li key={step.id} className={`trail-step ${step.done ? "trail-done" : ""} ${step.id === currentId ? "trail-current" : ""}`}><span className="loop-trail-mark"><input type="checkbox" checked={step.done} aria-label={`${step.done ? "Uncheck" : "Check"} step: ${step.text}`} title={step.completedAt ? `Done ${formatWhen(step.completedAt)}` : "Check this step; the loop stays open"} onChange={e => onChange({ steps: toggleStep(item, step.id, e.target.checked).steps })} /></span><div><InlineText value={step.text} label={`Edit step: ${step.text}`} maxLength={2000} required onSave={text => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, text } : s) })} />{step.people.length > 0 && <small className="trail-step-people">with {step.people.map(p => people.find(e => e.id === p.id)?.name ?? p.name).join(", ")}</small>}{openNotes[step.id] ? <div className="loop-notes trail-notes"><NotesBody value={step.notes} label={`Notes for step: ${step.text}`} autoEdit={!step.notes.trim()} onSave={notes => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, notes } : s) })} onDone={text => { if (!text) toggleNotes(step.id, false); }} /></div> : step.notes.trim() && <button type="button" className="loop-notes-preview trail-notes-preview" title="Show notes" onClick={() => toggleNotes(step.id, true)}><AlignLeft size={11} /><span>{notesPreview(step.notes)}</span></button>}<button type="button" className={`trail-notes-toggle ${step.notes.trim() ? "has-notes" : ""}`} aria-expanded={!!openNotes[step.id]} aria-label={`${openNotes[step.id] ? "Hide" : step.notes.trim() ? "Show" : "Add"} notes for step: ${step.text}`} title={openNotes[step.id] ? "Hide notes" : step.notes.trim() ? "Show notes" : "Add notes"} onClick={() => toggleNotes(step.id, !openNotes[step.id])}><AlignLeft size={13} /></button><StepPeople step={step} people={people} refreshPeople={refreshPeople} onAttach={person => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, people: [...s.people, person] } : s), people: item.people.some(p => p.id === person.id) ? item.people : [...item.people, person] })} onDetach={id => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, people: s.people.filter(p => p.id !== id) } : s) })} />{remove(step.id, step.text)}</div></li>;
  if (!moves.length && !item.next && !steps.length && item.resolved) return null;
  return <ol className="loop-trail connected-trail loop-step-trail">
    {earlier > 0 && <li className="trail-earlier"><span className="loop-trail-mark"><span className="trail-node" /></span><button onClick={() => setShowEarlier(v => !v)}>{showEarlier ? "Hide earlier steps" : `${earlier} earlier ${earlier === 1 ? "step" : "steps"}`}</button></li>}
    {(showEarlier ? entries : entries.slice(earlier)).map(({ move, step, next }) => step ? stepRow(step) : next ? <li key="next" className="trail-step trail-current"><span className="loop-trail-mark"><input type="checkbox" checked={false} disabled={item.resolved} aria-label={`Check step: ${item.next}`} title="Check this step; the loop stays open" onChange={onStep} /></span><div><InlineText value={item.next} label={`Edit step: ${item.next}`} maxLength={2000} onSave={value => onChange({ next: value })} />{remove("next", item.next)}</div></li> : <li key={move!.id} className="trail-step trail-done"><span className="loop-trail-mark"><input type="checkbox" checked readOnly disabled aria-label={`Done: ${move!.text}`} /></span><div><p title={formatWhen(move!.at)}>{move!.text}</p>{remove(move!.id, move!.text)}</div></li>)}
    {!item.resolved && <li className="trail-add"><span className="loop-trail-mark"><Plus size={11} /></span><QuickCapture draftKey={draftKey} placeholder={currentId ? "Then…" : "Next step…"} label={`Add a step to ${item.title}`} captureOnBlur onCapture={text => onChange({ steps: planSteps(item, text).steps })} /></li>}
  </ol>;
}
