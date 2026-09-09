// Lightweight EN/DE translation layer.
// The English string IS the key — t('Field App') returns the German text in DE
// mode and falls back to the key itself when no translation exists.

export type AppLang = 'EN' | 'DE';

const de: Record<string, string> = {
  // --- App shell / sidebar ---
  'Overview': 'Übersicht',
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
  'Basemap': 'Kartengrundlage',
  'Dark Canvas': 'Dunkle Karte',
  'OSM Streets': 'OSM Straßen',
  'Satellite Map': 'Satellitenkarte',
  'Map Legend': 'Kartenlegende',
  'Tap to activate map': 'Tippen zum Aktivieren',
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
  'PROJECT:': 'PROJEKT:',
  // The bucket labels themselves stay German in both modes - see DEPTH_BUCKETS.
  'Depth filter': 'Tiefenfilter',
  'Status filter': 'Statusfilter',
  // Collapsed mobile filter bar
  'Filter': 'Filter',
  'Show filters': 'Filter anzeigen',
  'Profile and settings': 'Profil und Einstellungen',
  'Language': 'Sprache',
  'Theme': 'Darstellung',
  'Light': 'Hell',
  'Dark': 'Dunkel',
  'Close': 'Schließen',
  // Target popup photo carousel.
  'Previous': 'Zurück',
  'Next': 'Weiter',
  'Download photo': 'Foto herunterladen',
  'Download this photo': 'Dieses Foto herunterladen',
  // Empty state for panels that only mean anything once a target has been excavated.
  'Investigated targets only': 'Nur für untersuchte Ziele',
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
  'Show more': 'Mehr anzeigen',

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
  'Failed to import GPR points.': 'Import der GPR-Ziele fehlgeschlagen.',

  // --- Access & permissions ---
  'Permissions': 'Berechtigungen',
  'Permission requests': 'Berechtigungsanfragen',
  'Field App - permission required': 'Feld-App - Berechtigung erforderlich',
  'Dashboard - permission required': 'Dashboard - Berechtigung erforderlich',
  'You do not have permission to open this area. Request access from your administrator.':
    'Sie haben keine Berechtigung für diesen Bereich. Bitte fordern Sie den Zugriff beim Administrator an.',
  'Your request has been sent to the administrator. You will get access once it is approved.':
    'Ihre Anfrage wurde an den Administrator gesendet. Sie erhalten Zugriff, sobald sie genehmigt wurde.',
  'Optional: why do you need access?': 'Optional: Wofür benötigen Sie den Zugriff?',
  'Request permission': 'Berechtigung anfragen',
  'Sending...': 'Wird gesendet...',
  'Approve': 'Genehmigen',
  'Deny': 'Ablehnen',
  'No pending requests.': 'Keine offenen Anfragen.',
  'Request sent to the administrator.': 'Anfrage an den Administrator gesendet.',
  'Could not send the request. Check your connection.':
    'Anfrage konnte nicht gesendet werden. Bitte Verbindung prüfen.',
  'Permission granted.': 'Berechtigung erteilt.',
  'Access granted.': 'Zugriff erteilt.',
  'Request denied.': 'Anfrage abgelehnt.',
  'Could not save the decision.': 'Entscheidung konnte nicht gespeichert werden.',
  'Invalid username or password.': 'Benutzername oder Passwort ist falsch.',
  'Registration failed.': 'Registrierung fehlgeschlagen.',
  'Offline: signed in locally. Data will sync when back online.':
    'Offline: lokal angemeldet. Daten werden synchronisiert, sobald wieder online.',
  'OFFLINE MODE: your password was not checked. Field app only; data syncs when back online.':
    'OFFLINE-MODUS: Ihr Passwort wurde nicht geprüft. Nur Feld-App; Daten werden synchronisiert, sobald wieder online.',
  'No connection, and this account has not signed in on this device before. Connect to the network to sign in.':
    'Keine Verbindung, und dieses Konto hat sich auf diesem Gerät noch nie angemeldet. Bitte für die Anmeldung mit dem Netzwerk verbinden.',
  'No connection. Creating an account needs the server; please try again once online.':
    'Keine Verbindung. Für die Kontoerstellung wird der Server benötigt; bitte erneut versuchen, sobald wieder online.',
  'You do not have permission to export reports.':
    'Sie haben keine Berechtigung, Berichte zu exportieren.',

  // --- Users & passwords ---
  'Users': 'Benutzer',
  'Administrator': 'Administrator',
  'Reset password': 'Passwort zurücksetzen',
  'reset pending': 'Zurücksetzung offen',
  'Temporary password for': 'Temporäres Passwort für',
  'Shown once. Pass it on now - it cannot be displayed again.':
    'Wird nur einmal angezeigt. Bitte jetzt weitergeben - es kann nicht erneut angezeigt werden.',
  'Done': 'Fertig',
  'Choose a new password': 'Neues Passwort vergeben',
  'Your administrator issued a temporary password. Set your own to continue.':
    'Ihr Administrator hat ein temporäres Passwort vergeben. Bitte vergeben Sie ein eigenes, um fortzufahren.',
  'Temporary password': 'Temporäres Passwort',
  'New password': 'Neues Passwort',
  'Repeat new password': 'Neues Passwort wiederholen',
  'Save password': 'Passwort speichern',
  'Password updated.': 'Passwort aktualisiert.',
  'The new password needs at least 8 characters.':
    'Das neue Passwort braucht mindestens 8 Zeichen.',
  'The two new passwords do not match.': 'Die neuen Passwörter stimmen nicht überein.',
  'Could not change the password.': 'Passwort konnte nicht geändert werden.',
  'Could not reset the password.': 'Passwort konnte nicht zurückgesetzt werden.',
  'Could not change access.': 'Zugriff konnte nicht geändert werden.',
  'Please ask your administrator to reset your password.':
    'Bitte wenden Sie sich an Ihren Administrator, um Ihr Passwort zurückzusetzen.',

  // --- Overview (post-login home) ---
  'UXO Target Sync Platform': 'UXO-Ziel-Sync-Plattform',
  'Survey anomalies out to the crew, excavation results back to the office.':
    'Messanomalien hinaus zum Trupp, Aushubergebnisse zurück ins Büro.',
  'Geophysical surveys produce a list of anomalies - points that might be ordnance. This platform puts that list in front of the people who dig, records what each excavation actually found, and syncs it back to the office.':
    'Geophysikalische Messungen liefern eine Liste von Anomalien – Punkte, die Kampfmittel sein könnten. Diese Plattform bringt diese Liste zu den Menschen, die graben, erfasst, was jeder Aushub tatsächlich ergeben hat, und synchronisiert es zurück ins Büro.',

  'Log what the excavation found': 'Erfassen, was der Aushub ergeben hat',
  'Browse and filter the targets for your survey area, open a point on the map, and record the excavation: Sohle-Status, Fundstück, actual depth, Länge/Breite/m³, photos and the Trupp & Geräte block.':
    'Ziele Ihres Messgebiets durchsuchen und filtern, einen Punkt auf der Karte öffnen und den Aushub erfassen: Sohle-Status, Fundstück, tatsächliche Tiefe, Länge/Breite/m³, Fotos und den Block Trupp & Geräte.',
  'It works with no network - targets are cached on the device and submissions queue locally until a connection returns.':
    'Funktioniert ohne Netz – Ziele werden auf dem Gerät zwischengespeichert und Eingaben lokal in eine Warteschlange gestellt, bis wieder eine Verbindung besteht.',
  'Your results sync back to the office when the device is online.':
    'Ihre Ergebnisse werden ins Büro synchronisiert, sobald das Gerät online ist.',
  'Open the Field App': 'Feld-App öffnen',

  'Review what the crew brought back': 'Auswerten, was der Trupp zurückgemeldet hat',
  'Progress, findings breakdown, Sohle split, evaluated-against-excavated depth accuracy and excavated volume, over the whole target set or any slice of it.':
    'Fortschritt, Fundverteilung, Sohle-Aufteilung, Tiefengenauigkeit bewertet gegen ausgehoben und Aushubvolumen – über den gesamten Zielbestand oder jeden Ausschnitt davon.',
  'Filter by project, status, instrument or depth, then export the selection as CSV or as the site report PDF.':
    'Nach Projekt, Status, Instrument oder Tiefe filtern und die Auswahl als CSV oder als Berichts-PDF exportieren.',
  'Open the Dashboard': 'Dashboard öffnen',

  'Access': 'Zugriff',
  'Your account has no surface yet': 'Ihr Konto hat noch keinen Bereich',
  'Access is granted per surface by an administrator. Ask for the one you need and they will decide on it.':
    'Der Zugriff wird pro Bereich von einem Administrator vergeben. Fordern Sie den benötigten Bereich an – der Administrator entscheidet darüber.',
  'Request the Field App': 'Feld-App anfordern',
  'Request the Dashboard': 'Dashboard anfordern'
};

export type Translator = (text: string) => string;

export function makeT(lang: AppLang): Translator {
  return (text: string) => (lang === 'DE' ? de[text] ?? text : text);
}
