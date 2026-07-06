import Dexie, { type Table } from 'dexie';

export interface LocalPoint {
  id: string;
  vm_nr: number;
  easting: number;
  northing: number;
  latitude: number;
  longitude: number;
  calculated_depth: number | null;
  
  // Opening metrics (Öffnung)
  opening_length: number | null;
  opening_width: number | null;
  opening_depth: number | null;
  opening_volume: number | null;
  
  find_description: string | null;
  image_id: number | null;
  remarks: string | null;
  created_at: string;
  
  local_status?: string;
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
