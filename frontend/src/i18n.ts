// Lightweight EN/DE translation layer.
// The English string IS the key — t('Field App') returns the German text in DE
// mode and falls back to the key itself when no translation exists.

export type AppLang = 'EN' | 'DE';

const de: Record<string, string> = {
  // --- App shell / sidebar ---
  'Field App': 'Feld-App',
  'Dashboard': 'Dashboard',
  'Sync': 'Sync',
  'Sync Data': 'Daten synchronisieren',
  'Online': 'Online',
  'Offline': 'Offline',
  'Network Connection: Online': 'Netzwerkverbindung: Online',
  'Network Connection: Offline': 'Netzwerkverbindung: Offline',
  'Sign Out': 'Abmelden',
  'User': 'Benutzer',
  'Switch to Light mode': 'Zum hellen Modus wechseln',
  'Switch to Dark mode': 'Zum dunklen Modus wechseln',
  'Expand Sidebar (Undock)': 'Seitenleiste ausklappen',
  'Collapse Sidebar (Dock)': 'Seitenleiste einklappen',

  // --- Field app: survey panel ---
  'Active Survey Area': 'Aktives Messgebiet',
  'Project ID': 'Projekt-ID',
  'All Projects': 'Alle Projekte',
  'Targets Detected': 'Ziele erfasst',
  'Search targets...': 'Ziele suchen...',
  'All VM Nr.': 'Alle VM-Nr.',
  'All Instruments': 'Alle Instrumente',
  'Georadar': 'Georadar',
  'Magnetic': 'Magnetik',
  'Magnetics': 'Magnetik',
  'Georadar Array': 'Georadar-Array',
  'TARGET LISTING': 'ZIELLISTE',
  'All Targets': 'Alle Ziele',
  'Investigated': 'Untersucht',
  'Pending': 'Offen',
  'PENDING': 'OFFEN',
  'EVALUATED DEPTH': 'BEWERTETE TIEFE',
  'Target Layer': 'Ziel-Layer',
  'Target': 'Ziel',
  'N/A': 'k. A.',

  // --- Field app: quick summary ---
  'Quick Summary': 'Kurzübersicht',
  'INVESTIGATION PROGRESS': 'UNTERSUCHUNGSFORTSCHRITT',
  'MAGNETIC TARGETS': 'MAGNETIK-ZIELE',
  'GEORADAR TARGETS': 'GEORADAR-ZIELE',

  // --- Map ---
  'Zoom In': 'Vergrößern',
  'Zoom Out': 'Verkleinern',
  'Fit bounds': 'Auf Ziele zoomen',
  'Basemap switcher': 'Kartenhintergrund wechseln',
  'Add Data Layer': 'Datenebene hinzufügen',
  'Dark Canvas': 'Dunkle Karte',
  'OSM Streets': 'OSM Straßen',
  'Satellite Map': 'Satellitenkarte',
  'Map Legend': 'Kartenlegende',
  'DRAG TO RE-POSITION': 'ZUM VERSCHIEBEN ZIEHEN',
  'Target ID': 'Ziel-ID',
  'UTM coords': 'UTM-Koordinaten',
  'Survey Layer': 'Mess-Layer',
  'Evaluated Depth': 'Bewertete Tiefe',
  'Field Log Feedback': 'Feld-Protokoll',
  'Sohle Status': 'Sohle-Status',
  'Volumen': 'Volumen',
  'Actual Depth': 'Tatsächliche Tiefe',
  'Investigator': 'Bearbeiter',
  'Notes': 'Bemerkungen',
  'Logged': 'Erfasst',
  'Submitted Pictures': 'Übermittelte Bilder',
  'Print PDF': 'PDF drucken',

  // Resolved target status badge (values come from getResolvedStatus)
  'unvisited': 'nicht besucht',
  'clear': 'frei',
  'uxo': 'kampfmittel',
  'scrap': 'schrott',
  'false_alarm': 'fehlalarm',

  // --- Dashboard ---
  'Operations Overview': 'Betriebsübersicht',
  'Clearance Analytics Dashboard': 'Räumungs-Analyse-Dashboard',
  'INSTRUMENT:': 'INSTRUMENT:',
  // The bucket labels themselves stay German in both modes - see DEPTH_BUCKETS.
  'Depth filter': 'Tiefenfilter',
  'Status filter': 'Statusfilter',
  'TOTAL TARGETS': 'ZIELE GESAMT',
  'INVESTIGATED': 'UNTERSUCHT',
  'SURVEY PROJECTS': 'MESSPROJEKTE',
  'Findings Status': 'Fundstatus',
  'Grouped Findings (Sorted Low to High)': 'Gruppierte Funde (aufsteigend sortiert)',
  'Frequency': 'Häufigkeit',
  'Excavation Integrity': 'Aushub-Integrität',
  'Sohle Status Split by Finding': 'Sohle-Status nach Fund',
  'Frei (Clear)': 'Frei',
  'Nicht Frei': 'Nicht Frei',
  'Target Log': 'Zielprotokoll',
  'Excavated Targets Database': 'Datenbank ausgehobener Ziele',
  'Sensor Accuracy': 'Sensorgenauigkeit',
  'Evaluated vs Excavated Depth': 'Bewertete vs. ausgehobene Tiefe',
  'Evaluated (Sensor)': 'Bewertet (Sensor)',
  'Excavated (Actual)': 'Ausgehoben (tatsächlich)',
  'MEAN ERROR': 'MITTLERER FEHLER',
  'ESTIMATION BIAS': 'SCHÄTZABWEICHUNG',
  'FPR (EMPTY)': 'FPR (LEER)',
  'Too Deep': 'Zu tief',
  'Too Shallow': 'Zu flach',
  'Balanced': 'Ausgeglichen',
  'Target Profiling': 'Zielprofilierung',
  'Target Dimensions (Stacked Serial Chart)': 'Zielabmessungen (gestapeltes Diagramm)',
  'Depth (m)': 'Tiefe (m)',
  'Length (m)': 'Länge (m)',
  'Width (m)': 'Breite (m)',
  'Volume (m³)': 'Volumen (m³)',
  'EVAL': 'BEW.',
  'EXCAV': 'AUSH.',

  // --- Feedback form ---
  'Field Application Form': 'Feld-Erfassungsformular',
  'Location Edit Mode Active:': 'Standort-Bearbeitung aktiv:',
  'Drag the target marker on the map to its exact location. Coordinates will update in real-time. Click "Submit" to save.':
    'Ziehen Sie den Zielmarker auf der Karte an die exakte Position. Die Koordinaten werden in Echtzeit aktualisiert. Zum Speichern auf „Absenden“ klicken.',
  'Instrument': 'Instrument',
  'Bewertete Tiefe (m)': 'Bewertete Tiefe (m)',
  'Coordinate (X; Y)': 'Koordinate (X; Y)',
  'Meter Cube Volume (m³)': 'Volumen (m³)',
  'Schreibe (Specify) *': 'Schreibe (Angabe) *',
  'Describe finding...': 'Fund beschreiben...',
  'Nicht Frei (Not Clear)': 'Nicht Frei',
  'Bemerkung (Remarks)': 'Bemerkung',
  'Write any additional remarks...': 'Zusätzliche Bemerkungen eintragen...',
  // --- Reports / export ---
  'Generate Report': 'Bericht erstellen',
  'Export CSV': 'CSV exportieren',
  'Download PDF': 'PDF herunterladen',
  'Download CSV': 'CSV herunterladen',
  'From': 'Von',
  'To': 'Bis',
  'Leave dates empty to include the whole period.': 'Datumsfelder leer lassen, um den gesamten Zeitraum einzuschließen.',
  'The start date must be before the end date.': 'Das Startdatum muss vor dem Enddatum liegen.',
  'Report generation failed. Check that the server is reachable.':
    'Berichtserstellung fehlgeschlagen. Bitte prüfen, ob der Server erreichbar ist.',

  'Teams and Tools': 'Trupp und Geräte',
  'Need update?': 'Aktualisierung nötig?',
  'Yes': 'Ja',
  'No': 'Nein',
  'No previous entry for this project yet - please fill the fields below.':
    'Für dieses Projekt liegt noch kein Eintrag vor – bitte die Felder unten ausfüllen.',
  'Attached Photos (Multiple)': 'Angehängte Fotos (mehrere)',
  'Bilder Number': 'Bilder-Anzahl',
  'Take Photo': 'Foto aufnehmen',
  'Upload Image': 'Bild hochladen',
  'Saving...': 'Speichern...',
  'Cancel': 'Abbrechen',
  'Submit': 'Absenden',
  'Camera Capture': 'Kameraaufnahme',
  'Capture': 'Aufnehmen',

  // --- Submission confirmation ---
  'Submission Received': 'Erfassung übermittelt',
  'Thank you! Your record has been submitted.': 'Vielen Dank! Ihr Datensatz wurde übermittelt.',
  'Would you like to add another record?': 'Möchten Sie einen weiteren Datensatz erfassen?',
  'Open Field Application Form': 'Feld-Erfassungsformular öffnen',
  'Back to Target List': 'Zurück zur Zielliste',
  'Syncing to the cloud database...': 'Wird mit der Cloud-Datenbank synchronisiert...',
  'Synced to the cloud database.': 'Mit der Cloud-Datenbank synchronisiert.',
  'Saved offline - it will sync automatically once back online.':
    'Offline gespeichert – wird automatisch synchronisiert, sobald wieder online.',
  'Not synced yet - the app will retry automatically.':
    'Noch nicht synchronisiert – die App versucht es automatisch erneut.',

  // --- Import / export panel ---
  'Seed Wilhelmshaven Targets': 'Wilhelmshaven-Ziele laden',
  'Seed Targets (Requires Online)': 'Ziele laden (Online erforderlich)',
  'Paste CSV Coordinates': 'CSV-Koordinaten einfügen',
  'Seedeich Seeding (Wilhelmshaven)': 'Seedeich-Datenimport (Wilhelmshaven)',
  'Load the exact 29 survey target points transcribed from the Wilhelmshaven Excel table. Converts Germany UTM coordinates to coordinates mapped on the Seedeich dyke.':
    'Lädt die 29 Messziele aus der Wilhelmshavener Excel-Tabelle. Die UTM-Koordinaten werden auf den Seedeich umgerechnet.',
  'Upload GPR Coordinate File': 'GPR-Koordinatendatei hochladen',
  'Choose a CSV file with coordinate columns X and Y (Germany UTM).':
    'Wählen Sie eine CSV-Datei mit den Koordinatenspalten X und Y (UTM).',
  'Choose CSV File': 'CSV-Datei wählen',
  'Parse and Load Points': 'Punkte einlesen und laden',

  // --- Auth modal ---
  'Username / Operator ID': 'Benutzername / Betreiber-ID',
  'Security Password': 'Passwort',
  'Enter collector or dashboard': 'collector oder dashboard eingeben',
  'Database Accounts:': 'Datenbank-Konten:',
  'Field Collector': 'Feld-Erfasser',
  'Dashboard Viewer': 'Dashboard-Betrachter',
  'Full Name': 'Vollständiger Name',
  'Corporate Email': 'Firmen-E-Mail',
  'Create Password': 'Passwort erstellen',
  'Development Mode:': 'Entwicklungsmodus:',
  'Account will be registered and logged in instantly. Access/Role is assigned at database level.':
    'Das Konto wird sofort angelegt und angemeldet. Zugriff/Rolle wird auf Datenbankebene vergeben.',
  'Username or Email': 'Benutzername oder E-Mail',
  'Enter your email': 'E-Mail-Adresse eingeben',

  // --- Toasts ---
  'Connection restored. Cloud sync enabled.': 'Verbindung wiederhergestellt. Cloud-Sync aktiv.',
  'Offline mode active. Logs queued in IndexedDB.': 'Offline-Modus aktiv. Einträge werden in IndexedDB zwischengespeichert.',
  'Sync aborted: Network is offline.': 'Sync abgebrochen: Netzwerk offline.',
  'Cloud database sync failed.': 'Sync mit der Cloud-Datenbank fehlgeschlagen.',
  'Failed to save feedback findings.': 'Speichern der Erfassung fehlgeschlagen.',
  'Failed to import GPR points.': 'Import der GPR-Ziele fehlgeschlagen.'
};

export type Translator = (text: string) => string;

export function makeT(lang: AppLang): Translator {
  return (text: string) => (lang === 'DE' ? de[text] ?? text : text);
}
