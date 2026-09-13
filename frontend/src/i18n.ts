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
  'Canvas': 'Grundkarte',
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
  'Findings by type': 'Funde nach Art',
  'Projects': 'Projekte',
  'Mean target dimensions by finding': 'Mittlere Zielabmessungen nach Fund',
  'Main navigation': 'Hauptnavigation',
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

  // --- Landing page ---
  'Menu': 'Menü',
  'Platform': 'Plattform',
  'Company': 'Unternehmen',
  'Sign in': 'Anmelden',
  'Get access': 'Zugang anfordern',
  'Get early access': 'Jetzt Zugang anfordern',
  'Investigated before': 'Untersucht, bevor es',
  "it's a problem": 'zum Problem wird',
  'Navigate every anomaly and UXO inspection with real-time, actionable target detection, automated GPR logging, and instant field-to-office sync.':
    'Führen Sie jede Anomalie- und Kampfmittelinspektion mit Echtzeit-Zieldetektion, automatisierter Radarderfassung und sofortiger Feld-Büro-Synchronisierung durch.',
  'carousel': 'Karussell',
  'Field operations': 'Feldeinsätze',
  'Choose a photo': 'Foto wählen',
  'Pause slideshow': 'Diashow anhalten',
  'Play slideshow': 'Diashow abspielen',
  'Magnetometer Survey': 'Magnetikmessung',
  'Hand-pushed multi-sensor gradiometer cart with RTK-GPS positioning':
    'Handgeführter Multisensor-Gradiometerwagen mit RTK-GPS-Ortung',
  'Georadar Survey (GPR)': 'Georadar-Messung (GPR)',
  'Tablet-controlled GPR cart profiling dense vegetation and embankments':
    'Tablet-gesteuerter GPR-Wagen für dichte Vegetation und Böschungen',
  'Rail Corridor Clearance': 'Räumung im Gleisbereich',
  'Track-guided sensor array for UXO detection in active rail infrastructure':
    'Gleisgeführtes Sensorarray zur Kampfmittelortung im Bahnbetrieb',
  'Vehicle-Towed Array': 'Fahrzeuggezogenes Array',
  'High-throughput towed magnetometer array for large open areas':
    'Leistungsstarkes Schlepp-Magnetometerarray für große Freiflächen',

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
  // Soft hyphen: at the rail's 12px the word is wider than the item, and this is
  // where it may break. Invisible wherever it fits on one line.
  'Permissions': 'Berech­tigungen',
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

  'Guided tours': 'Geführte Touren',
  'Finding a target, the map, the excavation form, offline and sync.':
    'Ziele finden, die Karte, das Aushubformular, offline und Sync.',
  'Take the Field App tour': 'Tour durch die Feld-App',
  'Filtering, the charts, depth accuracy, generating a report.':
    'Filtern, die Diagramme, die Tiefengenauigkeit, einen Bericht erstellen.',
  'Take the Dashboard tour': 'Tour durch das Dashboard',
  'Each tour runs on the live app and takes about a minute. Leave it whenever you like, and take it again from here or from your profile menu.':
    'Jede Tour läuft in der echten App und dauert etwa eine Minute. Sie können sie jederzeit verlassen und hier oder über Ihr Profilmenü erneut starten.',

  'Access': 'Zugriff',
  'Your account has no surface yet': 'Ihr Konto hat noch keinen Bereich',
  'Access is granted per surface by an administrator. Ask for the one you need and they will decide on it.':
    'Der Zugriff wird pro Bereich von einem Administrator vergeben. Fordern Sie den benötigten Bereich an – der Administrator entscheidet darüber.',
  'Request the Field App': 'Feld-App anfordern',
  'Request the Dashboard': 'Dashboard anfordern',

  // --- Guided tour ---
  'Field App tour': 'Feld-App-Tour',
  'Dashboard tour': 'Dashboard-Tour',
  'Step {n} of {total}': 'Schritt {n} von {total}',
  'Close tour': 'Tour schließen',
  'Back': 'Zurück',
  'Skip this step': 'Schritt überspringen',

  'Your survey area': 'Ihr Messgebiet',
  'Which survey area is loaded and how many targets it holds. The list and the map both follow it.':
    'Welches Messgebiet geladen ist und wie viele Ziele es enthält. Liste und Karte folgen beide dieser Auswahl.',
  'Find a target': 'Ein Ziel finden',
  'Search by VM number, or narrow the list by instrument and status. On a phone the filters fold behind the Filter bar.':
    'Nach VM-Nr. suchen oder die Liste nach Instrument und Status eingrenzen. Auf dem Handy liegen die Filter hinter der Filterleiste.',
  'The target list': 'Die Zielliste',
  'Every target in the area with its evaluated depth. Once a target has been dug, its chip shows what was found.':
    'Jedes Ziel im Gebiet mit seiner errechneten Tiefe. Sobald ein Ziel ausgehoben ist, zeigt sein Chip, was gefunden wurde.',
  'The map': 'Die Karte',
  'The same targets in place - red is pending, green is investigated.':
    'Dieselben Ziele an ihrem Ort – rot ist offen, grün ist untersucht.',
  'Try it: open a target': 'Ausprobieren: ein Ziel öffnen',
  'Tap any target in the list or on the map. The tour carries on as soon as its form opens.':
    'Tippen Sie auf ein beliebiges Ziel in der Liste oder auf der Karte. Die Tour geht weiter, sobald sich sein Formular öffnet.',
  'Record the excavation': 'Den Aushub erfassen',
  'Fundstück, Sohle-Status, actual depth, Länge/Breite/m³, photos and the Trupp & Geräte block. Nothing is saved until you press Submit - Cancel goes back to the list.':
    'Fundstück, Sohle-Status, tatsächliche Tiefe, Länge/Breite/m³, Fotos und der Block Trupp & Geräte. Gespeichert wird erst mit „Absenden“ – „Abbrechen“ führt zurück zur Liste.',
  'Offline and sync': 'Offline und Sync',
  'The Field App keeps working with no network. Submissions wait on the device, counted by a badge on Sync - press it once you are back online to send them to the office.':
    'Die Feld-App arbeitet auch ohne Netz weiter. Eingaben warten auf dem Gerät, gezählt von einem Abzeichen an Sync – tippen Sie darauf, sobald Sie wieder online sind, um sie ans Büro zu senden.',

  'Filter once, everything follows': 'Einmal filtern, alles folgt',
  'Narrow by project, instrument, depth and status. Every number, chart, the target log and the map follow the selection.':
    'Nach Projekt, Instrument, Tiefe und Status eingrenzen. Jede Zahl, jedes Diagramm, das Zielprotokoll und die Karte folgen der Auswahl.',
  'The headline numbers': 'Die Kennzahlen',
  'Total, investigated and pending targets, and how many survey projects the selection spans.':
    'Ziele gesamt, untersucht und offen – und wie viele Messprojekte die Auswahl umfasst.',
  'What was found': 'Was gefunden wurde',
  'Findings grouped by type. Below it, the Sohle split shows which excavations were left clear.':
    'Funde nach Art gruppiert. Darunter zeigt die Sohle-Aufteilung, welche Aushübe frei hinterlassen wurden.',
  'How accurate the survey was': 'Wie genau die Messung war',
  'Evaluated depth from the sensor against the depth actually excavated, with the mean error, the bias and the share of empty holes.':
    'Errechnete Tiefe des Sensors gegen die tatsächlich ausgehobene Tiefe, mit mittlerem Fehler, Tendenz und dem Anteil leerer Löcher.',
  'The target log': 'Das Zielprotokoll',
  'Every target in the selection. Select one to find it on the map.':
    'Jedes Ziel der Auswahl. Wählen Sie eines aus, um es auf der Karte zu finden.',
  'Try it: generate a report': 'Ausprobieren: einen Bericht erstellen',
  'Open Generate Report. On a phone it is inside the Filter bar.':
    'Öffnen Sie „Bericht erstellen“. Auf dem Handy liegt es in der Filterleiste.',
  'Export the selection': 'Die Auswahl exportieren',
  'Choose a project and, if you like, a date range. Download PDF gives the landscape A4 site report, Download CSV the raw rows.':
    'Projekt und, wenn gewünscht, einen Zeitraum wählen. „PDF herunterladen“ liefert den Objektbericht im A4-Querformat, „CSV herunterladen“ die Rohdaten.'
};

export type Translator = (text: string) => string;

export function makeT(lang: AppLang): Translator {
  return (text: string) => (lang === 'DE' ? de[text] ?? text : text);
}
