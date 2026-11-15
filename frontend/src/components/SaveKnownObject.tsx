import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { resolveSkyRegion } from '../api/frames';
import type { Frame } from '../api/frames';
import type { RegionSelection } from '../api/regions';
import { savedObjectNameLimit } from '../state/savedKnownObjects';
import { saveKnownObject } from '../state/savedKnownObjects';

export function SaveKnownObject({ selection, frame, onSaved }: {
  selection: RegionSelection;
  frame: Frame;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = name.trim();
    if (!label || request.current || savedName) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      const region = await resolveSkyRegion(selection, controller.signal);
      if (controller.signal.aborted) return;
      saveKnownObject(label, region, frame);
      setSavedName(label);
      onSaved();
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'Could not save this sky region.');
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return <section className="save-known-object" aria-labelledby="save-known-object-title">
    <h3 id="save-known-object-title">Save selected region</h3>
    {savedName ? <p role="status">Saved “{savedName}” in this browser. <a href="#home">View Known Objects on Home</a></p> :
      <form onSubmit={submit}>
        <label htmlFor="known-object-name">Object name</label>
        <input id="known-object-name" value={name} disabled={saving} required maxLength={savedObjectNameLimit}
          onChange={event => setName(event.target.value)} placeholder="Enter a name" />
        <button className="primary" disabled={saving || !name.trim()} type="submit">
          {saving ? 'Saving…' : 'Save as known object'}
        </button>
      </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
