# Unsere Familien-App

Eine eigene kleine App für Einkaufsliste, Aufgaben, Chat, Ideen und ein
Taschengeld-Konto – synchronisiert live über alle Handys, ganz ohne
Claude-Konto für die Nutzer.

## Was ist enthalten?

- `index.html` – die App selbst
- `style.css` – Design (Start im Dunkelmodus, umschaltbar)
- `app.js` – die gesamte Logik
- `firebase-config.js` – **hier trägst du deine eigenen Zugangsdaten ein**
- `firestore.rules` – Sicherheitsregeln für deine Datenbank

## Schritt 1: Firebase-Projekt anlegen (ca. 5 Minuten, kostenlos)

1. Gehe zu **https://console.firebase.google.com** und melde dich mit einem
   Google-Konto an.
2. Klicke auf **"Projekt hinzufügen"**, gib einen Namen ein (z.B.
   "familien-app"), Google Analytics kannst du deaktivieren.
3. Klicke im Projekt links auf das Symbol **"</>"** ("Web-App
   hinzufügen"), gib der App einen Namen und klicke auf **"Registrieren"**.
4. Firebase zeigt dir jetzt einen Codeblock mit `const firebaseConfig = {...}`.
   Kopiere genau diese Werte in die Datei **`firebase-config.js`** (ersetze
   die Platzhalter).
5. Gehe im Menü links auf **"Build" → "Firestore Database"** und klicke auf
   **"Datenbank erstellen"**. Wähle einen Standort in deiner Nähe (z.B.
   `eur3 (europe-west)`) und starte **im Testmodus**.
6. Gehe im Firestore-Bereich auf den Tab **"Regeln"** und ersetze den Inhalt
   durch den Inhalt der Datei `firestore.rules` aus diesem Projekt.
   Klicke auf **"Veröffentlichen"**.

Damit ist die Datenbank fertig eingerichtet.

## Schritt 2: App online stellen

Die einfachste Variante (kein Account nötig, kein Terminal):

1. Gehe zu **https://app.netlify.com/drop**
2. Ziehe den ganzen Ordner mit den App-Dateien (index.html, style.css,
   app.js, firebase-config.js) per Drag & Drop in das Browserfenster.
3. Nach ein paar Sekunden bekommst du einen Link wie
   `https://irgendwas.netlify.app` – das ist deine App!

Alternative: Firebase Hosting (bleibt beim selben Anbieter wie die
Datenbank) – melde dich, falls gewünscht, einfach nochmal und ich zeige dir
die genauen Befehle dafür.

## Schritt 3: Loslegen

1. Öffne den Link auf deinem Handy.
2. Melde dich mit dem Namen **"Alex"** an (dieser Name ist fest als Admin
   hinterlegt und wird beim ersten Login automatisch angelegt).
3. Gehe in den Admin-Bereich und lege dort die Namen aller anderen
   Familien-/Team-Mitglieder an – optional gleich mit ihren Wunschfarben.
4. Teile den Link mit allen anderen. Jeder gibt beim ersten Öffnen einmalig
   seinen Namen ein – das Gerät merkt sich das danach von selbst.

## Wichtig zu wissen: Sicherheit

Wie besprochen hat die App **kein Passwort** – jeder mit dem Link kann sich
grundsätzlich mit jedem der von Alex angelegten Namen anmelden. Für eine
Familien- oder Team-App unter Vertrauten ist das meist völlig ausreichend,
aber es ist kein Schutz gegen jemanden, der es wirklich böswillig darauf
anlegt. Behalte den Link daher wie ein Familiengeheimnis, gib ihn nur an
die gewünschten Personen weiter. Falls du später doch ein echtes
Passwort-Login möchtest, kann ich das jederzeit ergänzen (z.B. mit
Firebase Authentication).

## Änderungswünsche?

Melde dich einfach wieder bei mir – ich kann die Dateien jederzeit
anpassen oder erweitern.
