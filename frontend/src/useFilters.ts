import { useCallback, useMemo, useState } from 'react';
import { type LocalPoint } from './db/indexedDb';
import { type Translator } from './i18n';

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
  /** A single project id, or 'all'. Changing it resets the category - see below. */
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
  /** A single anomalies.category value (Kat-1, Kat-2 ...), or 'all'. */
  category: string;
  setCategory: (value: string) => void;
}

/**
 * An independent filter group. Call it once per view.
 *
 * Both groups carry the same fields even though the Dashboard currently renders
 * controls for only some of them. That symmetry is the point: the unrendered fields
 * sit at their neutral defaults and constrain nothing, so the Dashboard cannot
 * inherit a search or a VM-Nr. it has no way to display - and adding a search box to
 * it later needs no new plumbing.
 */
export function useFilters(): FilterGroup {
  const [projectId, setProjectIdRaw] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [vmNr, setVmNr] = useState('all');
  const [status, setStatus] = useState('all');
  const [instrument, setInstrument] = useState('all');
  const [category, setCategory] = useState('all');

  // The category list narrows to the project in view, so a category picked under one
  // project may not exist under the next. Left in place it would filter every target
  // out behind a control that no longer lists the value it holds. Resetting here, in
  // the one setter every project picker goes through, means no view can reach that
  // state - and it is the same reset for both groups.
  const setProjectId = useCallback((value: string) => {
    setProjectIdRaw(value);
    setCategory('all');
  }, []);

  // Stable identity, changing only when a value in the group does. Callers memoize a
  // full pass over ~1700 targets on this, so a fresh object every render would defeat
  // the memo and hand the memoized FieldMap and Dashboard new array identities on
  // every unrelated render. The setters are stable, so the values are the only real
  // dependencies.
  return useMemo(() => ({
    projectId, setProjectId,
    searchQuery, setSearchQuery,
    vmNr, setVmNr,
    status, setStatus,
    instrument, setInstrument,
    category, setCategory,
  }), [projectId, setProjectId, searchQuery, vmNr, status, instrument, category]);
}

/** True when a target passes a category filter value ('all' passes everything). */
export function matchesCategory(p: LocalPoint, category: string): boolean {
  return category === 'all' || (p.category ?? '') === category;
}

/**
 * Apply one group to the full target set.
 *
 * Shared by both views so they can never drift on what a filter value means; what
 * differs between them is only which group they hand in.
 */
export function selectPoints(points: LocalPoint[], filters: FilterGroup): LocalPoint[] {
  const { projectId, searchQuery, vmNr, status, instrument, category } = filters;

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

    return matchesSearch && matchesVmNr && matchesStatus && matchesInstrument &&
      matchesProjectId && matchesCategory(p, category);
  });
}

/**
 * The value every CSV and import path writes when the source carries no category
 * (ingest_anomalies.py and both import endpoints in server.py). Only the SQL picks
 * migration carries a real classification through, and its source has no Kat-1, so
 * today every Kat-1 target is an unclassified one. The label says so rather than
 * letting Kat-1 read as a class the survey assigned.
 */
export const INGEST_DEFAULT_CATEGORY = 'Kat-1';

export function categoryLabel(value: string, t: Translator): string {
  return value === INGEST_DEFAULT_CATEGORY ? `${value} (${t('ingest default')})` : value;
}

/**
 * The category values present under one project ('all' for every project), in
 * natural order - Kat-2 before Kat-10. Derived from the targets rather than a fixed
 * list, so a project only offers the categories it actually has.
 */
export function categoriesForProject(points: LocalPoint[], projectId: string): string[] {
  const values = new Set<string>();
  for (const p of points) {
    if (!p.category) continue;
    if (projectId !== 'all' && p.project_id !== projectId) continue;
    values.add(p.category);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}
