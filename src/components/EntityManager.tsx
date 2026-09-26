"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import type { ViewEntity } from "@/lib/view-model";

export function EntityManager({ entity, entities, onSaved }: {
  entity?: ViewEntity; entities: ViewEntity[]; onSaved: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("person");
  const [title, setTitle] = useState("");
  const [org, setOrg] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [target, setTarget] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const suggestions = [...new Set(["Core team", ...entities.flatMap(e => e.profile?.tags ?? [])])];
  function open(next: string) {
    setName(entity?.name ?? ""); setType(entity?.entityType ?? entity?.type ?? "person");
    setTitle(entity?.profile?.title ?? ""); setOrg(entity?.profile?.org ?? "");
    setDescription(entity?.profile?.description ?? ""); setTags(entity?.profile?.tags ?? []);
    setTag(""); setTarget(""); setSearch(""); setError(""); setMode(next);
  }
  function addTag(value: string) {
    value = value.trim();
    if (value && !tags.some(t => t.toLowerCase() === value.toLowerCase())) setTags([...tags, value]);
    setTag("");
  }
  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/entities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: mode, id: entity?.id, targetId: target, name, type, title, org, description,
        tags: tag.trim() ? [...tags, tag.trim()] : tags,
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save changes.");
      await onSaved(mode === "delete" ? "" : data.id);
      setMode("");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="entity-actions">
      {entity ? <><button onClick={() => open("update")}>Edit & tags</button><button onClick={() => open("merge")}>Merge</button><button className="danger-text" onClick={() => open("delete")}>Delete</button></> : <button onClick={() => open("create")}>+ Add entity</button>}
    </div>
    <Dialog open={!!mode} onOpenChange={value => { if (!value && !busy) setMode(""); }}>
      <DialogContent className="entity-editor" showCloseButton={!busy}>
        <DialogTitle>{mode === "create" ? "Add entity" : mode === "update" ? "Edit entity" : mode === "merge" ? "Merge duplicate entities" : "Delete entity"}</DialogTitle>
        <DialogDescription>{mode === "merge" ? `Merge ${entity?.name} into the profile below. Its name and conflicting profile fields take priority. Tags, aliases, meeting evidence and connections are combined.` : mode === "delete" ? `Remove ${entity?.name} and its connections from the network? Original meeting evidence is retained. If this is you, the path starting point will be cleared.` : "Keep your network accurate and organize it with reusable tags."}</DialogDescription>
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <fieldset disabled={busy}>
            {(mode === "create" || mode === "update") && <>
              <label>Name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
              <label>Type<select value={type} onChange={e => setType(e.target.value)}><option value="person">Person</option><option value="organization">Organization</option><option value="fund">Fund</option></select></label>
              <label>Title<input maxLength={300} value={title} onChange={e => setTitle(e.target.value)} /></label>
              <label>Organization<input maxLength={300} value={org} onChange={e => setOrg(e.target.value)} /></label>
              <label>Notes / description<textarea maxLength={5000} rows={3} value={description} onChange={e => setDescription(e.target.value)} /></label>
              <label>Custom tags<div className="tag-input"><input aria-label="New tag" list="network-tag-suggestions" maxLength={60} placeholder="e.g. Core team, Investors…" value={tag} onChange={e => setTag(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(tag); } }} /><button type="button" onClick={() => addTag(tag)}>Add</button></div></label>
              <datalist id="network-tag-suggestions">{suggestions.map(t => <option key={t} value={t} />)}</datalist>
              <div className="editable-tags">{tags.map(t => <button key={t} type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter(x => x !== t))}>{t} ×</button>)}</div>
              {!tags.some(t => t.toLowerCase() === "core team") && <button type="button" onClick={() => addTag("Core team")}>+ Core team</button>}
            </>}
            {mode === "merge" && <>
              <label>Find the profile to keep<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or role" /></label>
              <label>Keep this entity<select required value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose an entity…</option>{entities.filter(e => e.id !== entity?.id && e.type === entity?.type && `${e.name} ${e.role}`.toLowerCase().includes(search.toLowerCase())).map(e => <option key={e.id} value={e.id}>{e.name} — {e.role}</option>)}</select></label>
              {target && <p><strong>{entity?.name}</strong> → <strong>{entities.find(e => e.id === target)?.name}</strong>. The duplicate disappears after merging.</p>}
            </>}
            {error && <p role="alert" className="danger-text">{error}</p>}
            <div className="entity-actions"><button type="button" onClick={() => setMode("")}>Cancel</button><button type="submit" className={mode === "delete" ? "danger-text" : ""} disabled={busy || (mode === "merge" && !target)}>{busy ? "Saving…" : mode === "delete" ? "Delete entity" : mode === "merge" ? "Merge entities" : "Save entity"}</button></div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
