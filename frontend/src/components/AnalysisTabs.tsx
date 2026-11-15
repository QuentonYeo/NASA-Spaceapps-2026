import type { KeyboardEvent } from 'react';

export type AnalysisView = 'static' | 'motion';
const views = [
  { id: 'static', label: 'Static analysis' },
  { id: 'motion', label: 'Object detection & measurements' },
] as const;

export function AnalysisTabs({ value, onChange }: { value: AnalysisView; onChange: (view: AnalysisView) => void }) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1
      : event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : null;
    if (next == null) return;
    event.preventDefault();
    onChange(views[next].id);
    document.getElementById(`analysis-tab-${views[next].id}`)?.focus();
  }
  return <div className="analysis-tabs" role="tablist" aria-label="Analysis views">
    {views.map((view, index) => <button key={view.id} id={`analysis-tab-${view.id}`} type="button" role="tab"
      aria-selected={value === view.id} aria-controls="analysis-workspace" tabIndex={value === view.id ? 0 : -1}
      onClick={() => onChange(view.id)} onKeyDown={event => navigate(event, index)}>{view.label}</button>)}
  </div>;
}
