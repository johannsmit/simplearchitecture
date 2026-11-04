import { useState } from 'react';
import { useBranding } from '../branding';
import { BrandMark } from '../icons';

/**
 * The company logo in place of the SimpleArchitecture mark, or the mark
 * when there is no logo or it fails to load. Only ever an <img> of the versioned logo route.
 */
export function BrandLogo({ className }: { className: string }) {
  const { logo, logoLoaded } = useBranding();
  // The URL that failed, so a new logo gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  if (!logo || failed === logo.url) return <BrandMark />;
  return (
    <img
      className={className}
      src={logo.url}
      alt="Company logo"
      decoding="async"
      draggable={false}
      style={logo.ratio === null ? undefined : { aspectRatio: String(logo.ratio) }}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) {
          logoLoaded(logo.url, naturalWidth / naturalHeight);
        }
      }}
      onError={() => {
        setFailed(logo.url);
      }}
    />
  );
}
