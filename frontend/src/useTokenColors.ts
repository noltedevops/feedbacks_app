import { useMemo } from 'react';
import { useTheme } from './useTheme';

// Token colours resolved to concrete values, for the places that cannot read var():
// Recharts writes series colours into SVG attributes, legends and tooltips, and a
// canvas fill takes a literal. Resolved from the body - where the theme class lives -
// and recomputed when the theme changes, so the tokens stay the only source.
export function useTokenColors<K extends string>(names: readonly K[]): Record<K, string> {
  const theme = useTheme();
  const key = names.join('|');
  return useMemo(() => {
    const s = getComputedStyle(document.body);
    const out = {} as Record<K, string>;
    for (const name of names) {
      const raw = s.getPropertyValue(name).trim();
      // rgb-triple tokens ("31 122 76") become rgb(); everything else passes through.
      out[name] = /^\d+\s+\d+\s+\d+$/.test(raw) ? `rgb(${raw.split(/\s+/).join(', ')})` : raw;
    }
    return out;
    // `names` is read through `key`, so a fresh array literal does not recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme]);
}
