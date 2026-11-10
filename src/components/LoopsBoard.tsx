"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { AlignLeft, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCheck, ChevronDown, Ellipsis, GitBranch, GripVertical, LayoutGrid, LockKeyhole, Pencil, Plus, Sparkles, Trash2, UserPlus, X } from "lucide-react";
import { LoopDependencies, LoopChainsView, LoopDependencyControls, LoopConnectionHandles, LoopInspectorConnections, useDependencyTarget, useDependencyHover } from "./LoopDependencies";
import { LoopMenu } from "./LoopMenu";
import { LoopsLayout } from "./LoopsLayout";
import { PersonPicker } from "./LoopPersonPicker";
import { StyledSelect } from "./ui/select";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { dependencyBlockers, cleanDependencies, restoreDependencies, LOOP_STATES, PATH_COLORS, PATH_PALETTE, pathDisplayColor, captureLoops, completeNext, loopsSchema, moveItem, needsMyMove, ownerName, recordLoop, planSteps, toggleStep, type LoopItem, type LoopPath, type LoopPerson } from "@/lib/loops";
import type { ViewEntity } from "@/lib/view-model";

type Drag = { type: "path" | "item"; id: string };
type Filter = "all" | "me" | "waiting" | "done" | "chains";
type ChangeStepPeople = (stepId: string, update: (people: LoopPerson[]) => LoopPerson[]) => void;
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
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; undo?: () => void } | null>(null);
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardTrigger = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const people = entities.filter(e => e.type === "person");
  useEffect(() => { if (!fresh.size) return; const t = setTimeout(() => setFresh(new Set()), 1800); return () => clearTimeout(t); }, [fresh]);

  useEffect(() => {
    if (!feedback || feedback.undo) return;
    const timeout = setTimeout(() => setFeedback(null), 2400);
    return () => clearTimeout(timeout);
  }, [feedback]);

  function openLoop(id: string, trigger: HTMLButtonElement) {
    cardTrigger.current = trigger;
    setSelectedId(id);
  }
  function closeLoop() {
    setSelectedId(null);
    const trigger = cardTrigger.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

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
    const validation = loopsSchema.safeParse(next);
    if (!validation.success) { setError(validation.error.issues[0]?.message || "Could not save this change."); return false; }
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
    const next = cleanDependencies(board.filter(p => p.id !== id));
    if (!commit(next)) return;
    if (capturePath === id) setCapturePath(next[0].id);
    setFeedback({ text: `Deleted “${path.name}”.`, undo: () => { const restored = [...latest.current!]; restored.splice(Math.min(index, restored.length), 0, path); commit(restoreDependencies(restored, board, new Set(path.items.map(item => item.id)))); } });
  }
  function changeItem(id: string, patch: Partial<LoopItem> | ((item: LoopItem) => Partial<LoopItem>)) {
    return commit(latest.current!.map(path => ({
      ...path,
      items: path.items.map(item => {
        if (item.id !== id) return item;
        const changes = typeof patch === "function" ? patch(item) : patch;
        return recordLoop({ ...item, ...changes }, item, "", people);
      }),
    })));
  }
  function addSteps(id: string, text: string) {
    return changeItem(id, item => ({ steps: planSteps(item, text).steps }));
  }
  function changeStepPeople(id: string, stepId: string, update: (people: LoopPerson[]) => LoopPerson[]) {
    return changeItem(id, item => {
      const legacy = stepId === "next";
      const step = legacy
        ? { id: crypto.randomUUID(), text: item.next.trim(), done: false, completedAt: null, people: [], notes: "" }
        : item.steps.find(step => step.id === stepId);
      if (!step?.text) return {};

      const attached = update(step.people);
      const updated = { ...step, people: attached };
      const people = [...item.people, ...attached.filter(person => !item.people.some(current => current.id === person.id))];
      if (!legacy) return { steps: item.steps.map(current => current === step ? updated : current), people };

      // A legacy next step has no person field. Move it into the trail at the same position.
      const steps = [...item.steps];
      const firstOpen = steps.findIndex(step => !step.done);
      steps.splice(firstOpen < 0 ? steps.length : firstOpen, 0, updated);
      return { next: "", steps, people };
    });
  }
  function setStepDone(id: string, stepId: string, done: boolean) {
    const board = latest.current!;
    const path = board.find(path => path.items.some(item => item.id === id));
    const item = path?.items.find(item => item.id === id);
    if (!path || !item) return false;
    if (stepId !== "next" && !item.steps?.some(step => step.id === stepId && step.done !== done)) return false;

    const updated = stepId === "next"
      ? done && item.next.trim() ? completeNext(item, people) : item
      : toggleStep(item, stepId, done);
    return updated !== item && commit(board.map(p => p === path
      ? { ...p, items: p.items.map(loop => loop === item ? updated : loop) }
      : p));
  }
  function removeStep(id: string, stepId: string) {
    return commit(latest.current!.map(p => ({ ...p, items: p.items.map(item => item.id !== id ? item : stepId === "next" ? { ...item, next: "" } : { ...item, steps: (item.steps ?? []).filter(s => s.id !== stepId), history: item.history.filter(h => h.event !== "move" || h.id !== stepId) }) })));
  }
  function deleteItem(id: string) {
    const board = latest.current!; const pathIndex = board.findIndex(p => p.items.some(i => i.id === id)); if (pathIndex < 0) return;
    const { id: pathId, items } = board[pathIndex]; const index = items.findIndex(i => i.id === id); const item = items[index];
    if (!commit(cleanDependencies(board.map(p => p.id === pathId ? { ...p, items: p.items.filter(i => i.id !== id) } : p)))) return;
    setFeedback({ text: `Deleted “${item.title}”.`, undo: () => commit(restoreDependencies(latest.current!.map(p => p.id === pathId ? { ...p, items: [...p.items.slice(0, index), item, ...p.items.slice(index)] } : p), board, new Set([id]))) });
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
    const items = latest.current!.flatMap(path => path.items);
    const item = items.find(item => item.id === id);
    if (resolved && item && dependencyBlockers(item, items).length) { setError("Complete this task's prerequisites first, or remove the dependency."); return; }
    if (changeItem(id, resolved ? { resolved } : { resolved, clearedAt: null })) setFeedback({ text: resolved ? "Loop completed." : "Loop reopened.", undo: resolved ? () => resolve(id, false) : undefined });
  }
  function capture(text: string, pathId: string) {
    const items = captureLoops(text); if (!items.length || !latest.current?.some(p => p.id === pathId)) return false;
    const saved = commit(latest.current.map(p => p.id === pathId ? { ...p, items: [...p.items, ...items] } : p));
    if (saved) {
      setFilter("all"); setFresh(new Set(items.map(i => i.id)));
      setFeedback({ text: items.length === 1 ? "Loop added." : `${items.length} loops added.` });
    }
    return saved;
  }
  function drop(event: DragEvent, pathId: string, itemId?: string) {
    if (!drag || drag.type === "path") return;
    event.preventDefault(); event.stopPropagation();
    commit(moveItem(latest.current!, drag.id, pathId, itemId));
    setDrag(null); setOver("");
  }
  function startDrag(event: DragEvent, value: Drag) { setDrag(value); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", value.id);
    const preview = event.currentTarget.closest<HTMLElement>(value.type === "path" ? ".loop-path" : ".loop-row");
    if (preview) event.dataTransfer.setDragImage(preview, 24, 24);
  }
  function exportAndReload() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(latest.current, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "loops-unsaved-copy.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); void load(true);
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const openItems = paths?.flatMap(p => p.items).filter(i => !i.resolved) ?? [];
  const allItems = paths?.flatMap(path => path.items) ?? [];
  const mine = openItems.filter(i => needsMyMove(i, today) && !dependencyBlockers(i, allItems).length).length;
  const matches = (item: LoopItem) => filter === "all" || (!item.resolved && (filter === "me"
    ? needsMyMove(item, today) && !dependencyBlockers(item, allItems).length
    : item.state === "waiting"));
  const selection = filter === "chains" ? undefined : allItems.find(item => item.id === selectedId);
  const selectedPath = selection && paths?.find(path => path.items.some(item => item.id === selection.id));

  return <section className="loops-workspace compact-loops">
    {(error || backupError) && <div className="loops-error" role="alert">{error || backupError}<button onClick={() => void (paths ? flush() : load())}>Retry</button>{conflict && <button onClick={exportAndReload}>Keep a copy &amp; refresh</button>}</div>}
    {feedback && <div key={feedback.text} className="loops-feedback" role="status"><Check size={14} />{feedback.text}{feedback.undo && <button onClick={() => { feedback.undo!(); setFeedback(null); }}>Undo</button>}<button className="feedback-dismiss" aria-label="Dismiss update" onClick={() => setFeedback(null)}><X size={13} /></button></div>}
    <header className="loops-overview">
      <div>
        <h1>Loops</h1>
        <p>{paths ? <>{openItems.length} open <span>·</span> {paths.length} {paths.length === 1 ? "board" : "boards"}</> : status}</p>
      </div>
      {paths && <div className="loops-overview-actions">
        <span className="loops-save-indicator" role="status" aria-label={status} title={status}>
          {status === "All changes saved" ? <><Check size={14} /> Saved</> : status}
        </span>
        <CaptureDock key={draftPrefix} draftKey={`${draftPrefix}:capture`} paths={paths} pathId={capturePath} onPathChange={setCapturePath} onCapture={text => capture(text, capturePath)} />
      </div>}
    </header>
    {paths && <LoopDependencies paths={paths} onChange={commit}>
      <LoopsLayout
        key={layoutKey}
        paths={paths}
        storageKey={layoutKey}
        onChange={commit}
        dragPathId={drag?.type === "path" ? drag.id : null}
        onDragFinish={() => { setDrag(null); setOver(""); }}
        previewMatches={item => filter === "done" ? !!item.clearedAt : !item.resolved && !item.clearedAt && matches(item)}
        content={filter === "chains" ? <LoopChainsView /> : undefined}
        inspector={selection && selectedPath && <LoopInspector
          key={selection.id}
          item={selection}
          path={selectedPath}
          paths={paths}
          people={people}
          blockers={dependencyBlockers(selection, allItems)}
          draftKey={`${draftPrefix}:${selection.id}`}
          refreshPeople={refreshPeople}
          onClose={closeLoop}
          onChange={patch => changeItem(selection.id, patch)}
          onAddStep={text => addSteps(selection.id, text)}
          onChangeStepPeople={(stepId, update) => changeStepPeople(selection.id, stepId, update)}
          onStep={(stepId, done) => setStepDone(selection.id, stepId, done)}
          onRemoveStep={stepId => removeStep(selection.id, stepId)}
          onResolve={() => resolve(selection.id, !selection.resolved)}
          onDelete={() => { deleteItem(selection.id); setSelectedId(null); }}
          onClear={() => clearLoops([selection])}
          onMove={destination => commit(moveItem(latest.current!, selection.id, destination))}
        />}
        toolbar={<div className="loops-filters" role="group" aria-label="Filter loops">
          {([
            ["all", "Board", null],
            ["me", "Needs me", mine],
            ["waiting", "Waiting", openItems.filter(i => i.state === "waiting").length],
            ["done", "Done", allItems.filter(i => i.clearedAt).length],
            ["chains", "Chains", null],
          ] as const).map(([id, label, count]) => <button key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setSelectedId(null); }}>
            {id === "all" && <LayoutGrid size={14} />}{id === "chains" && <GitBranch size={14} />}{label}{count !== null && <span>{count}</span>}
          </button>)}
        </div>}
      >
      {(path, index, organize) => <section key={path.id} className={`loop-path ${drag?.type === "path" && drag.id === path.id ? "is-dragging" : ""} ${over === path.id ? "drop-target" : ""}`} style={{ "--path-color": pathDisplayColor(path.color) } as CSSProperties}
        onDragOver={e => { if (drag?.type === "item") { e.preventDefault(); setOver(path.id); } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(""); }}
        onDrop={e => { if (drag?.type === "item") drop(e, path.id); }}>
        <header className="loop-path-header"><button className="loop-grip" draggable onDragStart={e => startDrag(e, { type: "path", id: path.id })} onDragEnd={() => { setDrag(null); setOver(""); }} aria-label={`Drag ${path.name} board`}><GripVertical size={16} /></button><InlineText value={path.name} label={`Board name: ${path.name}`} maxLength={100} required onSave={name => updatePath(path.id, { name })} /><span>{path.items.filter(i => !i.resolved).length}</span><LoopMenu className="loop-path-menu"><summary aria-label={`Options for ${path.name}`}><Ellipsis size={16} /></summary><div><button onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); organize(); }}>{path.stack ? "Change stack…" : "Move to stack…"}</button><small>Board color</small><div className="loop-swatches" role="group" aria-label="Board color">{PATH_PALETTE.map(({ color, name }) => <button key={color} aria-label={`Color ${name}`} title={name} aria-pressed={pathDisplayColor(path.color) === color} style={{ background: color }} onClick={() => updatePath(path.id, { color })}>{pathDisplayColor(path.color) === color && <Check size={13} />}</button>)}</div>{checkedOnBoard(path).length > 0 && <button onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); clearLoops(checkedOnBoard(path)); }}>Move {checkedOnBoard(path).length} checked to Done</button>}<button disabled={index === 0} onClick={() => reorderPath(path.id, index - 1)}>Move board earlier</button><button disabled={index === paths!.length - 1} onClick={() => reorderPath(path.id, index + 1)}>Move board later</button>{paths!.length > 1 && <button className="loop-path-delete" onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); deletePath(path.id); }}>Delete board</button>}</div></LoopMenu></header>
        <div className="loop-path-items" tabIndex={0} role="region" aria-label={`${path.name} loops`}><div className="loop-path-content">
          {filter === "done" ? (() => { const done = path.items.filter(i => i.clearedAt).sort((a, b) => b.clearedAt!.localeCompare(a.clearedAt!)); return done.length
            ? <div className="loop-done-list">{done.map(item => <div key={item.id} className="loop-resolved-row loop-done-row"><input type="checkbox" checked aria-label={`Reopen ${item.title}`} title="Reopen and put back on the board" onChange={() => resolve(item.id, false)} /><button className="loop-resolved-title" aria-label={`Open ${item.title}`} onClick={e => openLoop(item.id, e.currentTarget)}>{item.title}</button><time dateTime={item.clearedAt!} title={`Cleared ${formatWhen(item.clearedAt!)}`}>{formatDay(item.clearedAt!)}</time><button className="loop-clear-small" aria-label={`Delete ${item.title} for good`} title="Delete for good" onClick={() => deleteItem(item.id)}><Trash2 size={12} /></button></div>)}</div>
            : <p className="loop-empty-line">Nothing cleared here yet.</p>; })() : <>
          {(() => { const shown = path.items.filter(i => !i.clearedAt && matches(i)); const folded = foldedDone(shown); return <>
          {folded.size > 0 && <div className="loop-earlier-done"><div className="loop-earlier-done-bar"><button aria-expanded={!!showDone[path.id]} onClick={() => setShowDone(v => ({ ...v, [path.id]: !v[path.id] }))}><ChevronDown size={11} />{showDone[path.id] ? "Hide earlier done" : `${folded.size} earlier done`}</button><button className="loop-clear-all" onClick={() => clearLoops(checkedOnBoard(path))}>Move all to Done</button></div>{showDone[path.id] && shown.filter(item => folded.has(item.id)).map(item => <div key={item.id} className="loop-resolved-row"><input type="checkbox" checked aria-label={`Reopen ${item.title}`} title="Reopen this loop" onChange={() => resolve(item.id, false)} /><button className="loop-resolved-title" aria-label={`Open ${item.title}`} onClick={e => openLoop(item.id, e.currentTarget)}>{item.title}</button><button className="loop-clear-small" aria-label={`Move ${item.title} to Done`} title="Move to Done" onClick={() => clearLoops([item])}><CheckCheck size={12} /></button></div>)}</div>}
          {shown.filter(item => !folded.has(item.id)).map(item => <div key={item.id}
            className={`loop-card-slot ${over === item.id ? "drop-before" : ""}`}
            onDragOver={e => { if (drag?.type === "item") { e.preventDefault(); e.stopPropagation(); setOver(item.id); } }}
            onDrop={e => drop(e, path.id, item.id)}>
            <LoopCard item={item} fresh={fresh.has(item.id)} selected={selectedId === item.id} people={people} today={today}
              blockers={dependencyBlockers(item, allItems)}
              draftKey={`${draftPrefix}:${item.id}:planned-card`}
              onOpen={trigger => openLoop(item.id, trigger)}
              onAddStep={text => addSteps(item.id, text)}
              refreshPeople={refreshPeople}
              onChangeStepPeople={(stepId, update) => changeStepPeople(item.id, stepId, update)}
              onRemoveStep={stepId => removeStep(item.id, stepId)}
              onRename={title => changeItem(item.id, { title })}
              onRenameStep={(stepId, text) => changeItem(item.id, loop => stepId === "next"
                ? { next: text }
                : { steps: loop.steps.map(step => step.id === stepId ? { ...step, text } : step) })}
              onStep={stepId => setStepDone(item.id, stepId, true)}
              onResolve={() => resolve(item.id, !item.resolved)}
              onDragStart={e => startDrag(e, { type: "item", id: item.id })}
              onDragEnd={() => { setDrag(null); setOver(""); }} />
          </div>)}
          </>; })()}
          {!path.items.some(i => !i.clearedAt && matches(i)) && <p className="loop-empty-line">{filter === "all" ? "No loops yet" : filter === "me" ? "Nothing needs your move" : "No waiting loops"}</p>}
          <AddLoop key={`${draftPrefix}:${path.id}`} draftKey={`${draftPrefix}:${path.id}`} label={`Add a loop to ${path.name}`} onCapture={text => capture(text, path.id)} />
          </>}
        </div></div>
      </section>}
    </LoopsLayout></LoopDependencies>}
    {(() => { const target = paths?.find(p => p.id === confirmDelete); const count = target?.items.length ?? 0; return <Dialog open={!!target} onOpenChange={open => { if (!open) setConfirmDelete(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Delete “{target?.name}”?</DialogTitle><DialogDescription>This board and its {count === 1 ? "loop" : `${count} loops`} will be removed. You can undo right after.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="destructive" autoFocus onClick={() => target && deletePath(target.id, true)}>Delete board</Button></DialogFooter>
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
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
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
  return <div ref={container} className="loops-capture" onKeyDown={e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); switchMode(mode === "capture" ? "ask" : "capture"); }
    else if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest(".select-positioner"))) { e.stopPropagation(); close(); }
  }}>
    <Button ref={trigger} aria-expanded={open} aria-controls={open ? "loops-composer" : undefined} onClick={() => open ? close() : setOpen(true)}>
      <Plus size={16} /> New loop
    </Button>
    {open && <form id="loops-composer" className="loops-capture-panel" aria-label="Quick capture" onSubmit={e => { e.preventDefault(); submit(); }}>
      <div className="loops-capture-heading">
        <div className="dock-modes" role="group" aria-label="Composer mode">
          <button type="button" aria-pressed={mode === "capture"} onClick={() => switchMode("capture")}>New loops</button>
          <button type="button" aria-pressed={mode === "ask"} onClick={() => switchMode("ask")}><Sparkles size={12} /> Ask</button>
        </div>
        <button type="button" className="loops-icon-action" aria-label="Close capture" onClick={close}><X size={16} /></button>
      </div>
      <textarea ref={input} rows={3} aria-label={mode === "ask" ? "Ask a question about your loops" : "Loop titles"}
        placeholder={mode === "ask" ? "What’s waiting or blocked?" : "What needs to happen?"} value={text}
        onChange={e => { change(e.target.value); setAsked(false); }}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      {storageError ? <small role="alert">Draft backup unavailable. Add your loops before leaving.</small>
        : asked ? <small role="status">Ask is coming soon. Your draft is saved.</small>
        : mode === "capture" && <small>Use Shift+Enter to put each loop on its own line.</small>}
      <div className="loops-capture-footer">
        {mode === "capture"
          ? <StyledSelect label="Capture into board" value={pathId} onChange={onPathChange} compact options={paths.map(p => ({ value: p.id, label: p.name, color: pathDisplayColor(p.color) }))} />
          : <StyledSelect label="Ask across" value={scope} onChange={setScope} compact options={[{ value: "all", label: "All boards" }, { value: "me", label: "Needs me" }, ...paths.map(p => ({ value: p.id, label: p.name }))]} />}
        <Button type="submit" size="sm" disabled={!text.trim()}>{mode === "capture" ? "Add" : "Ask"} <ArrowRight size={13} /></Button>
      </div>
    </form>}
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
function NotesBody({ value, label, autoEdit = false, placeholder = "Add notes…", onSave, onDone }: { value: string; label: string; autoEdit?: boolean; placeholder?: string; onSave: (value: string) => void; onDone?: (value: string) => void }) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { const el = input.current; if (editing && el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  function finish() { const text = draft.trim(); if (text !== draft) onSave(text); setEditing(false); onDone?.(text); }
  if (editing) return <textarea ref={input} className="loop-notes-input" aria-label={label} value={draft} placeholder={placeholder} maxLength={4000} onChange={e => { setDraft(e.target.value); onSave(e.target.value); }} onBlur={finish} onKeyDown={e => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }} />;
  if (!value.trim()) return <button type="button" className="loop-notes-empty" onClick={() => setEditing(true)}>{placeholder}</button>;
  return <div className="loop-notes-view">
    <div className="loop-notes-text" onClick={() => { if (!window.getSelection()?.toString()) setEditing(true); }}><Linkified text={value} /></div>
    <button type="button" className="loop-notes-edit" aria-label={`Edit ${label}`} title="Edit notes" onClick={() => setEditing(true)}><Pencil size={12} /></button>
  </div>;
}

function AddLoop(props: { draftKey: string; label: string; onCapture: (text: string) => boolean }) {
  const [editing, setEditing] = useState(false);
  const restoreFocus = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      trigger.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [editing]);
  if (!editing) return <button ref={trigger} className="loop-add-button" aria-label={props.label} onClick={() => setEditing(true)}><Plus size={14} /> Add a loop</button>;
  return <div className="loop-add-row" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); restoreFocus.current = true; setEditing(false); } }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setEditing(false); }}><span className="loop-add-checkbox" aria-hidden="true" /><QuickCapture {...props} placeholder="What needs to happen?" autoFocus onCapture={text => { const saved = props.onCapture(text); if (saved) { restoreFocus.current = true; setEditing(false); } return saved; }} /></div>;
}

function QuickCapture({ id, autoFocus = false, draftKey, placeholder, onCapture, label, captureOnBlur = false }: { id?: string; autoFocus?: boolean; draftKey: string; placeholder: string; onCapture: (text: string) => boolean; label?: string; captureOnBlur?: boolean }) {
  const [text, setText] = useState(""); const [storageError, setStorageError] = useState(false); const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { try { setText(localStorage.getItem(`${draftKey}:input`) ?? ""); } catch { setStorageError(true); } }, [draftKey]);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  function change(value: string) { setText(value); try { if (value) localStorage.setItem(`${draftKey}:input`, value); else localStorage.removeItem(`${draftKey}:input`); } catch { setStorageError(true); } }
  function submit() { if (text.trim() && onCapture(text)) { change(""); input.current?.focus(); } }
  return <form className="loop-quick-capture" onSubmit={e => { e.preventDefault(); submit(); }}><textarea ref={input} id={id} aria-label={label ?? "Add loop in path"} rows={1} placeholder={placeholder} value={text} onChange={e => change(e.target.value)} onBlur={() => { if (captureOnBlur && document.hasFocus() && text.trim() && onCapture(text)) change(""); }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} /><button type="submit" aria-label="Add" disabled={!text.trim()}><Plus size={15} /></button>{storageError && <small role="alert">Draft backup unavailable. Capture this before leaving.</small>}</form>;
}

function TrailComposer({ title, draftKey, hasNext, onAdd, children }: {
  title: string; draftKey: string; hasNext: boolean; onAdd: (text: string) => boolean; children?: ReactNode;
}) {
  const id = useId();
  return <li className="trail-add">
    <label className="loop-trail-mark" htmlFor={id}><Plus size={11} /></label>
    <QuickCapture id={id} draftKey={draftKey} placeholder={hasNext ? "Then…" : "Next step…"}
      label={`Add a step to ${title}`} captureOnBlur onCapture={onAdd} />
    {children}
  </li>;
}

function CardText({ value, label, maxLength, onSave }: {
  value: string; label: string; maxLength: number; onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  const editing = draft !== null;

  useLayoutEffect(() => {
    if (editing && field.current) {
      const input = field.current;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  if (!editing) return <button ref={trigger} type="button" className="loop-card-text"
    aria-label={`${label}: ${value}`} onClick={() => setDraft(value)}>{value}</button>;

  return <textarea ref={field} className="loop-card-text" rows={1}
    aria-label={label} value={draft} maxLength={maxLength}
    onChange={e => setDraft(e.currentTarget.value)}
    onBlur={e => {
      const text = e.currentTarget.value.trim();
      if (text && text !== value) onSave(text);
      setDraft(null);
    }}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
      e.preventDefault();
      e.stopPropagation();
      restoreFocus.current = true;
      if (e.key === "Escape") setDraft(null);
      else e.currentTarget.blur();
    }} />;
}

function LoopCard({ item, fresh, selected, people, today, blockers, draftKey, refreshPeople, onOpen, onAddStep, onChangeStepPeople, onRemoveStep, onRename, onRenameStep, onStep, onResolve, onDragStart, onDragEnd }: {
  item: LoopItem; fresh: boolean; selected: boolean; people: ViewEntity[]; today: string; blockers: LoopItem[];
  draftKey: string; onOpen: (trigger: HTMLButtonElement) => void; onAddStep: (text: string) => boolean;
  refreshPeople: () => Promise<void>; onChangeStepPeople: ChangeStepPeople; onRemoveStep: (id: string) => boolean;
  onRename: (title: string) => void; onRenameStep: (id: string, text: string) => void;
  onStep: (id: string) => boolean; onResolve: () => void;
  onDragStart: (event: DragEvent) => void; onDragEnd: () => void;
}) {
  const connectionTarget = useDependencyTarget(item.id);
  const hoverDependency = useDependencyHover();
  const row = useRef<HTMLElement>(null);
  const open = useRef<HTMLButtonElement>(null);
  const stepFocus = useRef<number | null>(null);
  const [dragFromControl, setDragFromControl] = useState(false);
  const blocked = !item.resolved && blockers.length > 0;
  const state = stateOptions.find(option => option.value === item.state);
  const owner = item.ownerId && ownerName(item, people);
  const steps = item.steps ?? [];
  const next = item.next.trim();
  const upcoming = [...(next ? [{ id: "next", text: next, people: [] }] : []), ...steps.filter(step => !step.done)];
  const visible = item.resolved ? [] : upcoming.slice(0, 2);
  const completed = steps.filter(step => step.done).length + item.history.filter(event => event.event === "move").length;
  const total = completed + upcoming.length;
  const progress = total > 0 && <span className="loop-card-step-count" aria-live="polite" title={`${completed} of ${total} steps done`}>
    <span aria-hidden="true">{completed}/{total}</span>
    <span className="sr-only">{completed} of {total} steps done</span>
  </span>;
  const preview = total === 0 && notesPreview(item.context);
  const due = !!item.review && item.review <= today;

  useEffect(() => {
    if (fresh) row.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [fresh]);
  useEffect(() => {
    if (selected && matchMedia("(min-width: 1031px)").matches) row.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  useLayoutEffect(() => {
    const index = stepFocus.current;
    if (index === null) return;
    stepFocus.current = null;
    const inputs = row.current?.querySelectorAll<HTMLInputElement>(".loop-card-steps input[type='checkbox']");
    const target = inputs?.[Math.min(index, inputs.length - 1)] ?? open.current;
    target?.focus({ preventScroll: true });
  }, [item]);

  return <article ref={row} draggable={!dragFromControl}
    onPointerDownCapture={e => {
      const target = e.target;
      setDragFromControl(target instanceof Element && !!target.closest("input, textarea, label, details, button:not(.loop-card-text)"));
    }}
    onPointerUp={() => setDragFromControl(false)}
    onPointerCancel={() => setDragFromControl(false)}
    onDragStart={e => { if (e.target === e.currentTarget) onDragStart(e); }}
    onDragEnd={onDragEnd}
    onPointerEnter={() => hoverDependency?.(item.id)}
    onPointerLeave={() => hoverDependency?.(null)}
    onFocus={() => hoverDependency?.(item.id)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget) && !e.currentTarget.matches(":hover")) hoverDependency?.(null); }}
    onClick={e => { if (e.target instanceof Element && !e.target.closest("button, input, textarea, label, form, details")) open.current?.click(); }}
    data-loop-id={item.id}
    data-connection-target={connectionTarget}
    data-blocked={blocked}
    className={`loop-row loop-board-card ${selected ? "is-selected" : ""} ${item.resolved ? "is-checked" : ""} ${fresh ? "is-new" : ""}`}
  >
    <LoopConnectionHandles item={item} />
    <input type="checkbox" checked={item.resolved} disabled={blocked}
      aria-label={`${item.resolved ? "Reopen" : "Complete"} ${item.title}`}
      title={blocked ? `Waiting for ${blockers.map(loop => loop.title).join(", ")}` : undefined}
      onChange={onResolve} />
    <div className="loop-card-main">
      <div className="loop-card-title">
        <CardText label="Edit loop title" value={item.title} maxLength={200} onSave={onRename} />
      </div>
      {preview && <span className="loop-card-preview"><AlignLeft size={13} /><span>{preview}</span></span>}
      {item.resolved ? progress : <ol className="loop-trail connected-trail loop-step-trail loop-card-steps" aria-label={`Steps for ${item.title}`}>
          {visible.map((step, index) => <TrailStepRow key={step.id} step={step} people={people} current={index === 0}
            onCheck={e => {
              if (e.currentTarget === document.activeElement) stepFocus.current = index;
              if (!onStep(step.id)) stepFocus.current = null;
            }}
            editor={<CardText label="Edit step" value={step.text} maxLength={2000} onSave={text => onRenameStep(step.id, text)} />}
          >
            <StepActions step={step} people={people} refreshPeople={refreshPeople} onChangePeople={onChangeStepPeople}
              onRemove={() => {
                stepFocus.current = index;
                if (!onRemoveStep(step.id)) stepFocus.current = null;
              }} />
          </TrailStepRow>)}
          <TrailComposer title={item.title} draftKey={draftKey} hasNext={upcoming.length > 0} onAdd={onAddStep}>{progress}</TrailComposer>
        </ol>}
      {!item.resolved && <span className="loop-card-meta">
        <span className={`loop-card-state ${blocked ? "is-blocked" : ""}`}>
          {blocked ? <LockKeyhole size={11} /> : <i style={{ background: state?.color }} />}
          {blocked ? "Blocked" : state?.label}
        </span>
        {owner && <span className="loop-card-owner" title={owner}>{owner}</span>}
        {item.review && <span className={`loop-card-review ${due ? "is-due" : ""}`} title={`Review ${item.review}`}><CalendarDays size={12} />{due ? "Due" : formatDay(`${item.review}T00:00:00`)}</span>}
      </span>}
    </div>
    <div className="loop-card-actions">
      <button ref={open} type="button" className="loop-card-details loops-icon-action" aria-label={`Open ${item.title}`} title="Open loop details"
        aria-expanded={selected} aria-controls={selected ? "loop-inspector" : undefined} onClick={e => onOpen(e.currentTarget)}>
        <ArrowUpRight size={14} />
      </button>
      <LoopDependencyControls item={item} />
    </div>
  </article>;
}

function LoopInspector({ item, path, paths, people, blockers, draftKey, refreshPeople, onClose, onChange, onAddStep, onChangeStepPeople, onStep, onRemoveStep, onResolve, onDelete, onClear, onMove }: {
  item: LoopItem; path: LoopPath; paths: LoopPath[]; people: ViewEntity[]; blockers: LoopItem[];
  draftKey: string; refreshPeople: () => Promise<void>; onClose: () => void;
  onChange: (patch: Partial<LoopItem>) => boolean; onAddStep: (text: string) => boolean; onStep: (id: string, done: boolean) => boolean;
  onChangeStepPeople: ChangeStepPeople;
  onRemoveStep: (id: string) => void; onResolve: () => void; onDelete: () => void; onClear: () => void; onMove: (id: string) => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const blocked = !item.resolved && blockers.length > 0;
  const activity = item.history.filter(event => event.event !== "move" && (event.event !== "updated" || event.text !== "Updated loop"));

  useLayoutEffect(() => { close.current?.focus({ preventScroll: true }); }, []);

  return <aside className="loop-inspector" id="loop-inspector" aria-label="Loop details"
    style={{ "--path-color": pathDisplayColor(path.color) } as CSSProperties}
    onKeyDown={e => {
      if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof Element && e.target.closest(".select-positioner, details[open]"))) {
        e.stopPropagation();
        onClose();
      }
    }}>
    <header className="loop-inspector-head">
      <span className="loop-inspector-location"><i />{path.stack && path.stack.name !== path.name && <><span>{path.stack.name}</span><span aria-hidden="true">/</span></>}<span>{path.name}</span></span>
      <button ref={close} type="button" className="loops-icon-action" aria-label="Close loop details" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="loop-inspector-body">
      <label className="loop-inspector-title">
        <span className="sr-only">Title</span>
        <InlineText label="Loop title" value={item.title} required maxLength={200} onSave={title => onChange({ title })} />
      </label>
      <section className="loop-inspector-section">
        <h2>Description</h2>
        <NotesBody value={item.context} label="Loop description" placeholder="Add a description…" onSave={context => onChange({ context })} />
      </section>
      <section className="loop-inspector-section">
        <h2>Steps</h2>
        <Trail item={item} people={people} refreshPeople={refreshPeople} draftKey={`${draftKey}:planned`} onChange={onChange} onAddStep={onAddStep} onChangeStepPeople={onChangeStepPeople} onStep={onStep} onRemove={onRemoveStep} />
        {item.resolved && !item.next && !item.steps?.length && !item.history.some(event => event.event === "move") && <p className="loop-inspector-note">No steps recorded.</p>}
      </section>
      <section className="loop-inspector-section">
        <h2>Properties</h2>
        <div className="loop-inspector-properties">
          <div><span>Status</span><StyledSelect label="Status" value={item.state} onChange={state => onChange({ state: state as LoopItem["state"] })} compact options={stateOptions} /></div>
          <div><span>Next move</span><StyledSelect label="Next move" value={item.ownerId} onChange={ownerId => onChange({ ownerId })} compact options={[
            { value: "me", label: "Me" },
            { value: "", label: "Unassigned" },
            ...item.people.map(person => ({ value: person.id, label: people.find(entity => entity.id === person.id)?.name ?? person.name })),
          ]} /></div>
          <div><span>Board</span><StyledSelect label="Board" value={path.id} onChange={onMove} compact options={paths.map(board => ({ value: board.id, label: board.name, color: pathDisplayColor(board.color) }))} /></div>
          <div><label htmlFor="loop-review">Review date</label><input id="loop-review" type="date" value={item.review} onChange={e => onChange({ review: e.target.value })} /></div>
        </div>
      </section>
      <section className="loop-inspector-section">
        <h2>People</h2>
        {item.people.length > 0 && <div className="loop-people-chips">{item.people.map(person => <span key={person.id}>
          {people.find(entity => entity.id === person.id)?.name ?? person.name}
          <button aria-label={`Detach ${person.name}`} onClick={() => onChange({ people: item.people.filter(other => other.id !== person.id), ownerId: item.ownerId === person.id ? "" : item.ownerId })}><X size={12} /></button>
        </span>)}</div>}
        <PersonPicker people={people} attached={item.people} refreshPeople={refreshPeople} onAttach={person => onChange({ people: [...item.people, person] })} />
      </section>
      <section className="loop-inspector-section">
        <h2>Dependencies</h2>
        <LoopInspectorConnections item={item} blockers={blockers} />
      </section>
      {activity.length > 0 && <section className="loop-inspector-section">
        <h2>Activity</h2>
        <ol className="loop-trail loop-activity">{[...activity].reverse().map(event => <li key={event.id}><p>{event.text}</p><time dateTime={event.at}>{formatWhen(event.at)}</time></li>)}</ol>
      </section>}
    </div>
    <footer className="loop-inspector-footer">
      <Button variant="outline" size="sm" onClick={onResolve} disabled={blocked} title={blocked ? "Complete the prerequisites first" : undefined}>
        <Check size={14} />{item.resolved ? "Reopen" : "Complete"}
      </Button>
      {item.resolved && !item.clearedAt && <Button variant="outline" size="sm" onClick={onClear}><CheckCheck size={14} />Move to Done</Button>}
      <button type="button" className="loops-icon-action loop-inspector-delete" aria-label="Delete loop" title="Delete loop" onClick={onDelete}><Trash2 size={15} /></button>
    </footer>
  </aside>;
}

type Step = NonNullable<LoopItem["steps"]>[number];

function TrailStepRow({ step, people, current, disabled, onCheck, editor, children }: {
  step: Pick<Step, "text" | "people"> & Partial<Pick<Step, "done" | "completedAt">>;
  people: ViewEntity[]; current: boolean; disabled?: boolean;
  onCheck: (event: ChangeEvent<HTMLInputElement>) => void;
  editor: ReactNode; children?: ReactNode;
}) {
  return <li className={`trail-step ${step.done ? "trail-done" : ""} ${current ? "trail-current" : ""}`}>
    <span className="loop-trail-mark">
      <input type="checkbox" checked={step.done ?? false} disabled={disabled}
        aria-label={`${step.done ? "Uncheck" : "Check"} step: ${step.text}`}
        title={step.completedAt ? `Done ${formatWhen(step.completedAt)}` : "Check this step; the loop stays open"}
        onChange={onCheck} />
    </span>
    <div>
      {editor}
      {step.people.length > 0 && <small className="trail-step-people">
        with {step.people.map(person => people.find(entity => entity.id === person.id)?.name ?? person.name).join(", ")}
      </small>}
      {children}
    </div>
  </li>;
}

function StepActions({ step, people, refreshPeople, onChangePeople, onRemove }: {
  step: Pick<Step, "id" | "text" | "people">; people: ViewEntity[]; refreshPeople: () => Promise<void>;
  onChangePeople: ChangeStepPeople; onRemove: () => void;
}) {
  return <>
    <StepPeople step={step} people={people} refreshPeople={refreshPeople}
      onAttach={person => onChangePeople(step.id, attached => attached.some(current => current.id === person.id) ? attached : [...attached, person])}
      onDetach={id => onChangePeople(step.id, attached => attached.filter(person => person.id !== id))} />
    <RemoveStepButton text={step.text} onRemove={onRemove} />
  </>;
}

function RemoveStepButton({ text, onRemove }: { text: string; onRemove: () => void }) {
  return <button type="button" className="trail-remove" aria-label={`Delete step: ${text}`} title="Delete step" onClick={onRemove}>
    <Trash2 size={13} />
  </button>;
}

function StepPeople({ step, people, refreshPeople, onAttach, onDetach }: { step: Pick<Step, "text" | "people">; people: ViewEntity[]; refreshPeople: () => Promise<void>; onAttach: (person: LoopPerson) => void; onDetach: (id: string) => void }) {
  return <LoopMenu className="trail-person-menu">
    <summary aria-label={`Attach a person to step: ${step.text}`} title="Attach a person"><UserPlus size={13} /></summary>
    <div className="trail-person-panel">
      {step.people.length > 0 && <div className="loop-people-chips">{step.people.map(p => { const name = people.find(e => e.id === p.id)?.name ?? p.name; return <span key={p.id}>{name}<button type="button" aria-label={`Detach ${name} from step`} onClick={() => onDetach(p.id)}><X size={12} /></button></span>; })}</div>}
      <PersonPicker people={people} attached={step.people} refreshPeople={refreshPeople} onAttach={onAttach} />
    </div>
  </LoopMenu>;
}

const RECENT_DONE = 3;
const formatDay = (at: string) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const formatWhen = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Trail({ item, people, refreshPeople, draftKey, onChange, onAddStep, onChangeStepPeople, onStep, onRemove }: {
  item: LoopItem; people: ViewEntity[]; refreshPeople: () => Promise<void>; draftKey: string;
  onChange: (patch: Partial<LoopItem>) => boolean; onAddStep: (text: string) => boolean; onChangeStepPeople: ChangeStepPeople;
  onStep: (id: string, done: boolean) => boolean; onRemove: (stepId: string) => void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const toggleNotes = (id: string, open: boolean) => setOpenNotes(v => ({ ...v, [id]: open }));
  const moves = item.history.filter(h => h.event === "move");
  const steps = item.steps ?? [];
  const open = steps.filter(s => !s.done);
  const currentId = item.next ? "next" : open[0]?.id;
  type Entry = { move?: (typeof moves)[number]; step?: Step; next?: true };
  const entries: Entry[] = [...moves.map(move => ({ move })), ...steps.map(step => ({ step }))];
  if (item.next) { const at = entries.findIndex(e => e.step && !e.step.done); entries.splice(at < 0 ? entries.length : at, 0, { next: true }); }
  const leadingDone = entries.findIndex(e => e.next || (e.step && !e.step.done));
  const earlier = Math.max(0, (leadingDone < 0 ? entries.length : leadingDone) - RECENT_DONE);
  const stepRow = (step: Step) => <TrailStepRow key={step.id} step={step} people={people} current={step.id === currentId}
    onCheck={e => onStep(step.id, e.currentTarget.checked)}
    editor={<InlineText value={step.text} label={`Edit step: ${step.text}`} maxLength={2000} required
      onSave={text => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, text } : s) })} />}
  >
    {openNotes[step.id] ? <div className="loop-notes trail-notes">
      <NotesBody value={step.notes} label={`Notes for step: ${step.text}`} autoEdit={!step.notes.trim()}
        onSave={notes => onChange({ steps: steps.map(s => s.id === step.id ? { ...s, notes } : s) })}
        onDone={text => { if (!text) toggleNotes(step.id, false); }} />
    </div> : step.notes.trim() && <button type="button" className="loop-notes-preview trail-notes-preview"
      title="Show notes" onClick={() => toggleNotes(step.id, true)}><AlignLeft size={11} /><span>{notesPreview(step.notes)}</span></button>}
    <button type="button" className={`trail-notes-toggle ${step.notes.trim() ? "has-notes" : ""}`}
      aria-expanded={!!openNotes[step.id]}
      aria-label={`${openNotes[step.id] ? "Hide" : step.notes.trim() ? "Show" : "Add"} notes for step: ${step.text}`}
      title={openNotes[step.id] ? "Hide notes" : step.notes.trim() ? "Show notes" : "Add notes"}
      onClick={() => toggleNotes(step.id, !openNotes[step.id])}><AlignLeft size={13} /></button>
    <StepActions step={step} people={people} refreshPeople={refreshPeople} onChangePeople={onChangeStepPeople} onRemove={() => onRemove(step.id)} />
  </TrailStepRow>;
  if (!moves.length && !item.next && !steps.length && item.resolved) return null;
  return <ol className="loop-trail connected-trail loop-step-trail">
    {earlier > 0 && <li className="trail-earlier"><span className="loop-trail-mark"><span className="trail-node" /></span><button onClick={() => setShowEarlier(v => !v)}>{showEarlier ? "Hide earlier steps" : `${earlier} earlier ${earlier === 1 ? "step" : "steps"}`}</button></li>}
    {(showEarlier ? entries : entries.slice(earlier)).map(({ move, step, next }) => {
      if (step) return stepRow(step);
      if (next) return <TrailStepRow key="next" step={{ text: item.next, people: [] }} people={people} current disabled={item.resolved}
        onCheck={() => onStep("next", true)}
        editor={<InlineText value={item.next} label={`Edit step: ${item.next}`} maxLength={2000}
          onSave={value => onChange({ next: value })} />}
      >
        <StepActions step={{ id: "next", text: item.next, people: [] }} people={people} refreshPeople={refreshPeople}
          onChangePeople={onChangeStepPeople} onRemove={() => onRemove("next")} />
      </TrailStepRow>;
      return <li key={move!.id} className="trail-step trail-done">
        <span className="loop-trail-mark"><input type="checkbox" checked readOnly disabled aria-label={`Done: ${move!.text}`} /></span>
        <div><p title={formatWhen(move!.at)}>{move!.text}</p><RemoveStepButton text={move!.text} onRemove={() => onRemove(move!.id)} /></div>
      </li>;
    })}
    {!item.resolved && <TrailComposer title={item.title} draftKey={draftKey} hasNext={!!currentId} onAdd={onAddStep} />}
  </ol>;
}
