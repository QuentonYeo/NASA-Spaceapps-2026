import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisTabs } from './AnalysisTabs';

afterEach(() => vi.unstubAllGlobals());
it('exposes exactly two analysis tabs with the active tab in keyboard order', () => {
  const html = renderToStaticMarkup(<AnalysisTabs value="static" onChange={() => {}} />);
  expect(html.match(/role="tab"/g)).toHaveLength(2);
  expect(html).toContain('Static analysis');
  expect(html).toContain('Object detection &amp; measurements');
  expect(html).toContain('aria-selected="true" aria-controls="analysis-workspace" tabindex="0"');
});
it('switches the analysis view and keyboard focus together', () => {
  const onChange = vi.fn(), focus = vi.fn(), preventDefault = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal('document', { getElementById });
  const tabs = AnalysisTabs({ value: 'static', onChange }).props.children;
  tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault });
  expect(onChange).toHaveBeenLastCalledWith('motion');
  expect(getElementById).toHaveBeenLastCalledWith('analysis-tab-motion');
  expect(focus).toHaveBeenCalled();
  tabs[1].props.onKeyDown({ key: 'Home', preventDefault });
  expect(onChange).toHaveBeenLastCalledWith('static');
  tabs[1].props.onClick();
  expect(onChange).toHaveBeenLastCalledWith('motion');
});
