import type { Surface } from '../auth';

/**
 * The guided tours of the two surfaces.
 *
 * A step points at an element by its `data-tour` label - never by class, structure or
 * text. Most elements here have no class to speak of, the layout is free to change,
 * and every visible string is translated. The label is the entire contract with the
 * app's components: they carry it, and know nothing else about the tour.
 *
 * Titles and bodies are English source strings, translated through i18n.ts like the
 * rest of the app.
 */

export type TourId = Surface;

export interface TourStep {
  /**
   * `data-tour` labels, in order of preference. The first one on screen wins, so a
   * phone that folds a control away can point at the fold instead.
   */
  anchors: string[];
  title: string;
  body: string;
  /**
   * A "try it" step. The page stays usable, and the tour moves on by itself once an
   * element carrying this label appears. Next still works for anyone who would
   * rather not.
   */
  advanceOn?: string;
  /** The page stays usable on this step, without it being a "try it" step. */
  interactive?: boolean;
}

const field: TourStep[] = [
  {
    anchors: ['field.area'],
    title: 'Your survey area',
    body: 'Which survey area is loaded and how many targets it holds. The list and the map both follow it.',
  },
  {
    anchors: ['field.filters'],
    title: 'Find a target',
    body: 'Search by VM number, or narrow the list by instrument and status. On a phone the filters fold behind the Filter bar.',
  },
  {
    anchors: ['field.list'],
    title: 'The target list',
    body: 'Every target in the area with its evaluated depth. Once a target has been dug, its chip shows what was found.',
  },
  {
    anchors: ['field.map'],
    title: 'The map',
    body: 'The same targets in place - red is pending, green is investigated.',
  },
  {
    anchors: ['field.list'],
    advanceOn: 'field.form',
    title: 'Try it: open a target',
    body: 'Tap any target in the list or on the map. The tour carries on as soon as its form opens.',
  },
  {
    anchors: ['field.form'],
    title: 'Record the excavation',
    body: 'Fundstück, Sohle-Status, actual depth, Länge/Breite/m³, photos and the Trupp & Geräte block. Nothing is saved until you press Submit - Cancel goes back to the list.',
  },
  {
    anchors: ['field.sync'],
    title: 'Offline and sync',
    body: 'The Field App keeps working with no network. Submissions wait on the device, counted by a badge on Sync - press it once you are back online to send them to the office.',
  },
];

const dashboard: TourStep[] = [
  {
    anchors: ['dash.filters'],
    title: 'Filter once, everything follows',
    body: 'Narrow by project, instrument, depth and status. Every number, chart, the target log and the map follow the selection.',
  },
  {
    anchors: ['dash.stats'],
    title: 'The headline numbers',
    body: 'Total, investigated and pending targets, and how many survey projects the selection spans.',
  },
  {
    anchors: ['dash.findings'],
    title: 'What was found',
    body: 'Findings grouped by type. Below it, the Sohle split shows which excavations were left clear.',
  },
  {
    anchors: ['dash.accuracy'],
    title: 'How accurate the survey was',
    body: 'Evaluated depth from the sensor against the depth actually excavated, with the mean error, the bias and the share of empty holes.',
  },
  {
    anchors: ['dash.log'],
    title: 'The target log',
    body: 'Every target in the selection. Select one to find it on the map.',
  },
  {
    anchors: ['dash.report', 'dash.filters'],
    advanceOn: 'report-dialog',
    title: 'Try it: generate a report',
    body: 'Open Generate Report. On a phone it is inside the Filter bar.',
  },
  {
    anchors: ['report-dialog'],
    interactive: true,
    title: 'Export the selection',
    body: 'Choose a project and, if you like, a date range. Download PDF gives the landscape A4 site report, Download CSV the raw rows.',
  },
];

export const TOURS: Record<TourId, TourStep[]> = { field, dashboard };

export const TOUR_NAME: Record<TourId, string> = {
  field: 'Field App tour',
  dashboard: 'Dashboard tour',
};
