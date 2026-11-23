import { useEffect, useState } from 'react';

/** The relationship just added: lit for 3s, then the light goes out. */
export function useLitRelationship() {
  const [litId, setLitId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (litId === undefined) return;
    const timer = setTimeout(() => {
      setLitId(undefined);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [litId]);
  return [litId, setLitId] as const;
}
