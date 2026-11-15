import { useState } from 'react';

interface Props {
  autoUrl?: string;
  lockedUrl: string;
  alt: string;
  thumbnail?: boolean;
  showFallback?: boolean;
}

export function AlignedPreview({ autoUrl, lockedUrl, alt, thumbnail, showFallback }: Props) {
  const [autoFailed, setAutoFailed] = useState(false);
  const useAuto = !!autoUrl && !autoFailed;

  return <>
    <img src={useAuto ? autoUrl : lockedUrl} alt={alt} loading={thumbnail ? 'lazy' : undefined}
      onError={useAuto ? () => setAutoFailed(true) : undefined} />
    {showFallback && !useAuto && <span className="aligned-contrast-notice" role="status">
      Auto contrast unavailable. Showing locked contrast.
    </span>}
  </>;
}
