import { useState } from 'react';
import { useBranding, type BrandLogo as Logo } from '../branding';
import { BrandMark } from '../icons';
import { useTheme } from '../theme';

/**
 * The company logo in place of the SimpleArchitecture mark: in the Dark theme its own logo when
 * there is one, else the logo; the mark when there is none or they fail to load. Only ever an
 * <img> of a versioned logo route. A theme switch swaps it at once.
 */
export function BrandLogo({ className }: { className: string }) {
  const { logo, darkLogo, logoLoaded } = useBranding();
  const theme = useTheme();
  // The URLs that failed, so a new logo gets a fresh try.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const candidates = theme === 'dark' ? [darkLogo, logo] : [logo];
  const shown = candidates.find(
    (candidate): candidate is Logo => candidate !== null && !failed.includes(candidate.url),
  );
  if (!shown) return <BrandMark />;
  return (
    <img
      key={shown.url}
      className={className}
      src={shown.url}
      alt="Company logo"
      decoding="async"
      draggable={false}
      style={shown.ratio === null ? undefined : { aspectRatio: String(shown.ratio) }}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) {
          logoLoaded(shown.url, naturalWidth / naturalHeight);
        }
      }}
      onError={() => {
        setFailed((current) => [...current, shown.url]);
      }}
    />
  );
}
