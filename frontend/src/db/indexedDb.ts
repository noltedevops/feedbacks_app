import Dexie, { type Table } from 'dexie';

export interface LocalPoint {
  id: string;
  project_id: string;
  target_id: string;
  vm_nr: string; // hypenated string
  easting: number;
  northing: number;
  latitude: number;
  longitude: number;
  evaluated_depth: number | null; // renamed
  
  // Opening metrics (Öffnung)
  opening_length: number | null;
  opening_width: number | null;
  opening_depth: number | null;
  opening_volume: number | null;
  
  find_description: string | null;
  image_id: number | null;
  remarks: string | null;
  created_at: string;
  instrument?: string;
  
  local_status?: string; // 'pending' or 'investigated'
  layer?: string;
  feedback?: {
    id: string;
    visited: boolean;
    status: string;
    actual_depth: number | null;
    photos: string[]; // Array of base64 strings
    notes: string | null;
    investigator: string | null;
    investigator_username?: string | null;
    logged_at: string;
    
    // New fields
    target_id: string;
    sohle_status: string;
    bilder_n: number;
    other: string | null;
    fundstueck: string;
    laenge: number | null;
    breite: number | null;
    m_cube: number | null;
  } | null;
}

export interface PendingFeedback {
  id: string; // uuid
  point_id: string;
  visited: boolean;
  status: string;
  actual_depth: number | null;
  photos: string[]; // Array of base64 strings
  notes: string | null;
  investigator: string | null;
  investigator_username?: string | null;
  logged_at: string;
  
  // New fields
  target_id: string;
  sohle_status: string;
  bilder_n: number;
  other: string | null;
  fundstueck: string;
  laenge: number | null;
  breite: number | null;
  m_cube: number | null;
}

export interface PendingPointUpdate {
  id: string; // matches point.id
  easting: number;
  northing: number;
  latitude: number;
  longitude: number;
}

class NolteFieldDb extends Dexie {
  points!: Table<LocalPoint>;
  pendingFeedback!: Table<PendingFeedback>;
  pendingPointUpdates!: Table<PendingPointUpdate>;

  constructor() {
    super('NolteFieldDb');
    this.version(1).stores({
      points: 'id, vm_nr, local_status',
      pendingFeedback: 'id, point_id, status'
    });
    this.version(2).stores({
      points: 'id, vm_nr, local_status',
      pendingFeedback: 'id, point_id, status',
      pendingPointUpdates: 'id'
    });
  }
}

export const db = new NolteFieldDb();

// Dynamic status resolution helper
export function getResolvedStatus(point: LocalPoint): 'unvisited' | 'clear' | 'scrap' | 'uxo' | 'false_alarm' {
  if (!point.feedback || !point.feedback.visited) {
    return 'unvisited';
  }
  
  const fund = point.feedback.fundstueck || '';
  const sohle = point.feedback.sohle_status || '';
  const notes = (point.feedback.notes || '') + (point.feedback.other || '');
  
  if (fund === 'ohne Fund') {
    return 'false_alarm';
  }
  
  if (notes.toLowerCase().includes('uxo') || 
      notes.toLowerCase().includes('mine') || 
      notes.toLowerCase().includes('bomb') ||
      notes.toLowerCase().includes('munition') ||
      notes.toLowerCase().includes('pmn')) {
    return 'uxo';
  }
  
  if (sohle === 'Nicht Frei') {
    return 'scrap';
  }
  
  return 'clear';
}
