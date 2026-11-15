import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  label: string;
  kind: string;
  className: string;
  style: CSSProperties;
  enabled: boolean;
  onInspect: () => void;
  children?: ReactNode;
}

export function FrameMarker({ label, kind, className, style, enabled, onInspect, children }: Props) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const isOpen = anchor !== null;

  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      setAnchor(rect && rect.bottom > 0 && rect.top < window.innerHeight &&
        rect.right > 0 && rect.left < window.innerWidth ? rect : null);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen]);

  if (!enabled) return <span className={className} style={style} role="img" aria-label={label}>{children}</span>;

  function inspect(target: HTMLButtonElement) {
    onInspect();
    setAnchor(target.getBoundingClientRect());
  }

  const width = Math.min(218, window.innerWidth - 24);
  const left = anchor && Math.max(12, Math.min(window.innerWidth - width - 12,
    anchor.right + width + 12 <= window.innerWidth ? anchor.right + 10 : anchor.left - width - 10));
  const top = anchor && Math.max(12, Math.min(window.innerHeight - 132, anchor.top - 14));

  return <>
    <button ref={trigger} type="button" className={`${className} frame-marker-trigger`} style={style} aria-label={label}
      aria-describedby={anchor ? id : undefined}
      onMouseEnter={(event) => inspect(event.currentTarget)}
      onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setAnchor(null); }}
      onFocus={(event) => inspect(event.currentTarget)}
      onBlur={() => setAnchor(null)}
      onClick={(event) => inspect(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setAnchor(null);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
      }}>{children}</button>
    {anchor && createPortal(<div id={id} role="tooltip" className="marker-details" style={{ width, left: left ?? 12, top: top ?? 12 }}>
      <strong>{label}</strong>
      <small>Sample details</small>
      <dl><div><dt>Type</dt><dd>{kind}</dd></div><div><dt>Review</dt><dd>Pending</dd></div></dl>
    </div>, document.body)}
  </>;
}
