import { useSyncExternalStore } from 'react';

// The theme as the stylesheet sees it: App puts body.dark-theme on and off, and the
// tokens key off that one class. Most components never need this - var() in an inline
// style follows the theme on its own. It exists for the few things CSS cannot switch,
// like which basemap tiles to request.
//
// Read from the body class rather than threaded down as a prop, so a component deep
// in the tree cannot disagree with the page about which theme is showing.

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

const getSnapshot = (): 'dark' | 'light' =>
  document.body.classList.contains('dark-theme') ? 'dark' : 'light';

export function useTheme(): 'dark' | 'light' {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'light');
}
