"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, KeyRound, Eye, EyeOff, Settings2, RefreshCw } from "lucide-react";
import { PROVIDERS, type ListedModel, type Provider, type PublicSettings } from "@/lib/ai-providers";
import { Button } from "./ui/button";

function fallbackModels(provider: Provider): ListedModel[] {
  return PROVIDERS[provider].models.map(id => ({ id, label: id }));
}

export function AISettings({ onSaved, onIntegrations }: { onSaved: () => void; onIntegrations: () => void }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [listed, setListed] = useState<ListedModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [query, setQuery] = useState("");
  const loadSeq = useRef(0);

  async function load() {
    setError("");
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load settings. Please retry.");
      const data: PublicSettings = await response.json();
      setSettings(data); setProvider(data.provider); setModel(data.providers[data.provider].model);
      setModelsLoading(data.providers[data.provider].configured);
    } catch (e) { setError((e as Error).message); }
  }

  async function loadModels(forProvider: Provider, unsavedKey?: string) {
    const seq = ++loadSeq.current;
    setModelsLoading(true); setModelsError("");
    try {
      const response = await fetch("/api/settings/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: forProvider, apiKey: unsavedKey || undefined }) });
      const data = await response.json() as { models?: ListedModel[]; error?: string };
      if (seq !== loadSeq.current) return;
      if (!response.ok) throw new Error(data.error || "Could not load models.");
      setListed(data.models ?? []);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setListed([]); setModelsError((e as Error).message);
    } finally {
      if (seq === loadSeq.current) setModelsLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!settings) return;
    const typed = key.trim();
    if (!typed && !settings.providers[provider].configured) {
      loadSeq.current += 1;
      setListed([]); setModelsError(""); setModelsLoading(false);
      return;
    }
    if (typed && typed.length < 20) return;
    setModelsLoading(true);
    const timer = setTimeout(() => { void loadModels(provider, typed || undefined); }, typed ? 700 : 0);
    return () => clearTimeout(timer);
  }, [provider, settings, key]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    if (!model) { setError("Choose a model."); setBusy(false); return; }
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, apiKey: key, removeKey: remove }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save settings.");
      setSettings(data); setKey(""); setRemove(false); setShow(false);
      setMessage("Settings saved. Your next AI request will use this provider and model."); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const current = settings?.providers[provider];
  const canList = Boolean(key.trim() || current?.configured);
  const options = useMemo(() => {
    const source = listed.length ? listed : fallbackModels(provider);
    return [
      ...(model && !source.some(item => item.id === model) ? [{ id: model, label: model }] : []),
      ...source,
    ];
  }, [listed, model, provider]);
  const visible = options.filter(item => {
    const haystack = `${item.label} ${item.id}`.toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  });

  return <div className="ai-settings">
    <section className="content-card">
      <div className="section-title"><div><div className="eyebrow">AI CONFIGURATION</div><h2>Your models, your keys.</h2><p className="muted">Choose the model that extracts relationships and answers network questions.</p></div><KeyRound size={24} /></div>
      {error && <p role="alert" className="notice">{error}</p>}
      {!settings ? <Button variant="outline" onClick={() => void load()}>Load settings</Button> : <form onSubmit={save}>
        <fieldset disabled={busy}>
          <div className="provider-options" role="group" aria-label="AI provider">
            {(Object.entries(PROVIDERS) as Array<[Provider, typeof PROVIDERS[Provider]]>).map(([id, p]) => <button type="button" key={id} aria-pressed={provider === id} className={`provider-option ${provider === id ? "selected" : ""}`} onClick={() => { setProvider(id); setModel(settings.providers[id].model); setListed([]); setModelsError(""); setModelsLoading(settings.providers[id].configured); setQuery(""); setKey(""); setRemove(false); setShow(false); setMessage(""); }}><strong>{p.label}</strong><small>{settings.providers[id].configured ? "Key configured" : "Add an API key"}</small>{provider === id && <Check size={17} />}</button>)}
          </div>
          <div className="ai-fields">
            <label htmlFor="ai-key">API key <span className="muted">{current?.source === "saved" ? "· Saved on this server" : current?.source === "environment" ? "· Using environment variable" : "· Not configured"}</span></label>
            <div className="api-key-field"><input id="ai-key" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={key} disabled={remove} onChange={e => { setKey(e.target.value); setMessage(""); }} placeholder={current?.configured ? "Leave blank to keep the existing key" : "Paste your provider API key"} /><button type="button" aria-label={show ? "Hide API key" : "Show API key"} onClick={() => setShow(!show)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
            {current?.source === "saved" && <label className="remove-key"><input type="checkbox" checked={remove} onChange={e => setRemove(e.target.checked)} /> Remove saved key when saving (environment key will be used if set)</label>}
            <small>Keys are stored in a local server settings file, never in browser storage or returned by the settings API. These settings apply to this app installation.</small>
            <label htmlFor="ai-model-filter">Model</label>
            <div className="model-field">
              <input id="ai-model-filter" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search models" autoComplete="off" />
              <button type="button" aria-label="Refresh models" disabled={!canList || modelsLoading} onClick={() => void loadModels(provider, key.trim() || undefined)}><RefreshCw size={16} /></button>
            </div>
            <div className="model-options" role="listbox" aria-label="Available models">
              {visible.map(item => (
                <button type="button" role="option" key={item.id} aria-selected={model === item.id} className={`model-option ${model === item.id ? "selected" : ""}`} onClick={() => { setModel(item.id); setMessage(""); }}>
                  <strong>{item.label}</strong>
                  {item.label !== item.id && <small>{item.id}</small>}
                  {model === item.id && <Check size={16} />}
                </button>
              ))}
              {visible.length === 0 && <p className="muted">{modelsLoading ? "Loading models…" : "No models match that search."}</p>}
            </div>
            {modelsError ? <p role="alert" className="notice">{modelsError}</p> : modelsLoading ? <small>Loading models available to this key…</small> : listed.length > 0 ? <small>{listed.length} models loaded from your {PROVIDERS[provider].label} account. The model must support structured JSON output.</small> : <small>{canList ? "Showing suggested models until the provider list loads. Use refresh if this stays short." : "Suggested models — add an API key to load everything available to your account."}</small>}
          </div>
          <div className="settings-save"><Button className="primary-button" type="submit">{busy ? "Saving…" : "Save settings"}</Button><span className="muted">Applies to future requests</span></div>
        </fieldset>
        {message && <p role="status" className="settings-success"><Check size={16} />{message}</p>}
      </form>}
    </section>
    <section className="content-card integration-settings"><div><Settings2 size={21} /><h2>Meeting integrations</h2><p className="muted">Connect Granola to bring your conversations into your network.</p></div><Button variant="outline" onClick={onIntegrations}>Manage integrations</Button></section>
  </div>;
}
