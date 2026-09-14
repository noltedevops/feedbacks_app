import { useMemo, useState } from 'react';
import { type LocalPoint } from './db/indexedDb';

/**
 * One view's target filters.
 *
 * The Field App and the Dashboard each hold their own group. They used to share a
 * single set of useState hooks in App, which meant narrowing one view silently
 * narrowed the other: picking Georadar on the dashboard filtered the field crew's
 * map, and a search string left in the field app cut every dashboard total down
 * with no control on that screen to show it or undo it.
 *
 * The project is in here too, since the split. It was first kept out as app-wide
 * scoping the two views were meant to agree on, but in use the crew and the office
 * look at different sites at the same time, and a project picked on one screen
 * changing what the other shows was the same surprise as every other shared filter.
 * Each view now owns its project like it owns its status.
 *
 * The depth bucket is not in here, for the opposite reason: it is a dashboard
 * control with no field equivalent, and it was already scoped correctly. It composes
 * on top of this in App.
 */
export interface FilterGroup {
  /** A single project id, or 'all'. */
  projectId: string;
  setProjectId: (value: string) => void;
  /** Free text over VM-Nr. and find description. */
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  /** A single VM-Nr., or 'all'. */
  vmNr: string;
  setVmNr: (value: string) => void;
  /** 'all' | 'investigated' | 'pending'. */
  status: string;
  setStatus: (value: string) => void;
  /** 'all' | 'georadar' | 'magnetic'. */
  instrument: string;
  setInstrument: (value: string) => void;
}

/**
 * An independent filter group. Call it once per view.
 *
 * Both groups carry the same four fields even though the Dashboard currently renders
 * controls for only two of them. That symmetry is the point: the unrendered fields
 * sit at their neutral defaults and constrain nothing, so the Dashboard cannot
 * inherit a search or a VM-Nr. it has no way to display - and adding a search box to
 * it later needs no new plumbing.
 */
export function useFilters(): FilterGroup {
  const [projectId, setProjectId] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [vmNr, setVmNr] = useState('all');
  const [status, setStatus] = useState('all');
  const [instrument, setInstrument] = useState('all');

  // Stable identity, changing only when a value in the group does. Callers memoize a
  // full pass over ~1500 targets on this, so a fresh object every render would defeat
  // the memo and hand the memoized FieldMap and Dashboard new array identities on
  // every unrelated render. useState setters are already stable, so the values are
  // the only real dependencies.
  return useMemo(() => ({
    projectId, setProjectId,
    searchQuery, setSearchQuery,
    vmNr, setVmNr,
    status, setStatus,
    instrument, setInstrument,
  }), [projectId, searchQuery, vmNr, status, instrument]);
}

/**
 * Apply one group to the full target set.
 *
 * Shared by both views so they can never drift on what a filter value means; what
 * differs between them is only which group they hand in.
 */
export function selectPoints(points: LocalPoint[], filters: FilterGroup): LocalPoint[] {
  const { projectId, searchQuery, vmNr, status, instrument } = filters;

  return points.filter(p => {
    const matchesSearch = p.vm_nr.toString().includes(searchQuery) ||
                          (p.find_description && p.find_description.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesVmNr = vmNr === 'all' || p.vm_nr.toString() === vmNr;

    let matchesStatus = true;
    const isInvestigated = p.local_status && p.local_status !== 'unvisited';
    if (status === 'investigated') {
      matchesStatus = !!isInvestigated;
    } else if (status === 'pending') {
      matchesStatus = !isInvestigated;
    }

    const matchesInstrument = instrument === 'all' ||
                              (p.instrument && p.instrument.toLowerCase() === instrument.toLowerCase());

    const matchesProjectId = projectId === 'all' || p.project_id === projectId;

    return matchesSearch && matchesVmNr && matchesStatus && matchesInstrument && matchesProjectId;
  });
}
