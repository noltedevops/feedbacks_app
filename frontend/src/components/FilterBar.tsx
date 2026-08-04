import React, { useState } from 'react';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';

interface FilterBarProps {
  // "Filter" - the word on the bar itself.
  label: string;
  // The current selection, rendered on the collapsed bar so the active state stays
  // readable without expanding. Long values ellipsize rather than wrap.
  summary: string;
  // Accessible name for the toggle, e.g. "Filter anzeigen".
  toggleLabel: string;
  children: React.ReactNode;
}

let barSeq = 0;

// Mobile-only: folds a stack of filter controls behind a one-line bar so the screen
// opens on content instead of on a screenful of dropdowns. Folded by default - the
// summary line is what makes that safe, because the active selection is still visible.
// Desktop never renders this; both callers keep their inline controls at wide widths.
export const FilterBar: React.FC<FilterBarProps> = ({ label, summary, toggleLabel, children }) => {
  const [open, setOpen] = useState(false);
  const [id] = useState(() => `filterbar-${++barSeq}`);

  return (
    <div className="filter-bar">
      <button
        type="button"
        className="filter-bar-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={toggleLabel}
      >
        <SlidersHorizontal size={15} className="filter-bar-icon" />
        <span className="filter-bar-label">{label}:</span>
        <span className="filter-bar-summary" title={summary}>{summary}</span>
        <ChevronDown
          size={16}
          className="filter-bar-chevron"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div id={id} className="filter-bar-body">
          {children}
        </div>
      )}
    </div>
  );
};
