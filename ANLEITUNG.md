# RESSLER-DOKUMENTE auf Cloudflare — Schritt für Schritt

Diese Fassung läuft im Gratis-Tarif von Cloudflare. Rechnen Sie mit 30–40 Minuten.

**Was anders ist als bei der Server-Fassung:** Dokumente werden nur so lange aufbewahrt, wie ein
Vorgang läuft. Nach der Unterschrift laden Sie das PDF und das Protokoll herunter, legen beides in
Ihrer Kundenakte ab und löschen den Vorgang. Was Sie vergessen zu löschen, verschwindet nach
14 Tagen von selbst.

---

## Schritt 1 · Dateien zu GitHub — ganz im Browser

Vorher ein Handgriff: Blenden Sie versteckte Dateien ein, sonst sehen Sie `.gitignore` nicht.
Windows: im Explorer **Ansicht → Einblenden → Ausgeblendete Elemente**. Mac: **Cmd + Shift + Punkt**.

1. **ZIP entpacken.** Rechtsklick → „Alle extrahieren". Wirklich entpacken, nicht nur hineinklicken.
2. **Leeres Repository anlegen.** Auf github.com oben rechts das Plus → **New repository**.
   Name: `ressler-dokumente-cloudflare`, Sichtbarkeit **Private**.
   **Keinen** Haken bei „Add a README file" — das Repository muss leer bleiben. → **Create repository**.
3. **Upload öffnen.** Auf der folgenden Seite den Link *uploading an existing file* anklicken.
4. **Inhalt hineinziehen.** Den entpackten Ordner öffnen, mit `Strg + A` alles markieren und ins
   Browserfenster ziehen.

> **Der häufigste Fehler:** Ziehen Sie den **Inhalt** des Ordners hinein, nicht den Ordner selbst.
> In der Liste müssen anschließend `wrangler.jsonc`, `package.json`, `src` und `public` direkt
> nebeneinander stehen. Sehen Sie stattdessen nur einen einzelnen Ordner, in den Sie erst
> hineinklicken müssen, findet Cloudflare die Konfiguration später nicht und der Bau bricht ab.

5. **Prüfen und bestätigen.** Sind `.gitignore` und `.dev.vars.example` in der Liste? Dann unten auf
   **Commit changes**. Der Upload dauert wegen der Schriftdateien ein bis zwei Minuten.

Fehlt `.gitignore`, tragen Sie sie einfach nach: **Add file → Create new file**, als Namen
`.gitignore` eintippen, diese drei Zeilen hineinschreiben, **Commit changes**:

```
node_modules/
.wrangler/
.dev.vars
```

---

## Schritt 2 · Speicherplatz anlegen (R2)

Hier landen die Dokumente, solange ein Vorgang läuft. **Machen Sie das vor Schritt 3** — fehlt der
Bucket, schlägt die Bereitstellung fehl.

1. Im Cloudflare-Dashboard links auf **R2 Object Storage**.
2. Beim ersten Mal fragt Cloudflare nach einer Zahlungsmethode. **Das ist eine reine Hinterlegung** —
   die ersten 10 GB sind dauerhaft kostenlos, und Ihre Dokumente werden nie in die Nähe davon kommen.
3. **Create bucket**, Name exakt: `ressler-dokumente`
   Kein anderer Name, keine Großbuchstaben — er muss genau mit dem Eintrag in `wrangler.jsonc`
   übereinstimmen.
4. Standort **EU** wählen — das erspart Ihnen bei der DSGVO-Dokumentation einiges.

---

## Schritt 3 · Worker anlegen und mit GitHub verbinden

1. Im Dashboard auf **Compute (Workers)** → **Create** → Reiter **Import a repository**.
2. Repository auswählen.

> **Wenn Ihr neues Repository nicht in der Liste steht:** Dann hat Cloudflare bei der ersten
> Verbindung nur bestimmte Repositories freigegeben bekommen. Auf github.com Ihr Profilbild →
> **Settings** → links unten **Applications** → **Installed GitHub Apps** → bei
> **Cloudflare Workers and Pages** auf **Configure** → unter **Repository access** entweder das neue
> Repository ergänzen oder gleich **All repositories** wählen → **Save**. Danach die Cloudflare-Seite
> neu laden. Prüfen Sie außerdem, ob oben links das richtige GitHub-Konto ausgewählt ist.

3. Die beiden Befehlsfelder füllen:
   * **Build command:** `npm install`
   * **Deploy command:** `npx wrangler deploy`
4. **Create and deploy.**

> **Wenn nach „Bereitstellen" nichts passiert und kein Fehler erscheint:** Der Bau läuft im
> Hintergrund und meldet Fehlschläge nicht in der Oberfläche. Gehen Sie auf
> **Compute (Workers)** → Ihren Worker → Reiter **Builds** bzw. **Deployments** und öffnen Sie den
> letzten Eintrag. Dort steht die eigentliche Meldung. Die drei häufigsten Gründe: Der R2-Bucket
> fehlt oder heißt anders, `wrangler.jsonc` liegt nicht im obersten Verzeichnis, oder das Feld
> Build command war leer. Nach dem Beheben genügt **Retry deployment**.

Der erste Durchlauf dauert ein bis zwei Minuten. Danach haben Sie eine Adresse wie
`ressler-dokumente.IHR-NAME.workers.dev`.

Rufen Sie sie auf. Sie sehen jetzt einen Hinweis, dass Zugangsdaten fehlen — genau richtig, die
kommen als Nächstes.

---

## Schritt 4 · Zugangsdaten hinterlegen

Diese Werte gehören **nicht** ins Repository, sondern verschlüsselt zu Cloudflare.

Im Worker → **Settings** → **Variables and Secrets** → **Add**, dabei jeweils **Secret** auswählen
(nicht „Text"):

| Name | Wert |
|---|---|
| `ADMIN_EMAIL` | `kevin.ressler@ergo.de` |
| `ADMIN_PASSWORD` | Ihr Passwort |

Nach dem Speichern startet der Worker neu. Rufen Sie die Adresse erneut auf — jetzt erscheint die
Anmeldung. Melden Sie sich an und laden Sie testweise ein PDF hoch.

**An dieser Stelle ist die Anwendung vollständig einsatzbereit.** Den Kunden erreichen Sie über
„In meinem E-Mail-Programm öffnen" oder indem Sie den Link kopieren. Schritt 5 brauchen Sie nur,
wenn Sie zusätzlich automatischen Versand möchten.

---

## Schritt 5 · Resend einrichten

Die Anwendung läuft in zwei Betriebsarten. Der Unterschied ist **eine eigene Domain** — und der
Grund dafür ist kein Resend-Sonderweg, sondern Branchenstandard: Kein seriöser Versanddienst lässt
Sie an fremde Adressen schreiben, bevor Sie nachgewiesen haben, dass Ihnen die Absenderdomain
gehört. Sonst könnte jeder in Ihrem Namen Mails verschicken.

| | ohne Domain | mit Domain |
|---|---|---|
| Signaturlink erzeugen | ✓ | ✓ |
| Benachrichtigung an Sie, mit unterschriebenem PDF im Anhang | ✓ | ✓ |
| Signaturmail an den Kunden aus dem System | — | ✓ |

Eine Domain kostet 10 bis 15 Euro im Jahr und lässt sich direkt bei Cloudflare registrieren.

### 5.1 Kontoadresse prüfen — der entscheidende Punkt

Bei `resend.com` anmelden, unter **Settings** nachsehen, mit welcher E-Mail-Adresse Ihr Konto
angelegt ist.

Ohne bestätigte Domain darf Resend **nur an genau diese eine Adresse** schreiben. Sie muss deshalb
mit der Benachrichtigungsadresse übereinstimmen. Steht in `wrangler.jsonc` bei `NOTIFY_EMAIL` eine
andere, ändern Sie sie dort (auf github.com die Datei öffnen, Stift-Symbol, Wert anpassen,
**Commit changes**).

### 5.2 Schlüssel erzeugen

Bei Resend links **API Keys** → **Create API Key**. Name beliebig, Berechtigung *Sending access*
genügt. Der Schlüssel beginnt mit `re_` und wird **nur einmal angezeigt** — sofort kopieren.

### 5.3 In Cloudflare hinterlegen

Im Worker → **Einstellungen** → **Variablen und Secrets** → **Hinzufügen**:

| Name | Typ | Wert |
|---|---|---|
| `RESEND_API_KEY` | **Secret** | der kopierte Schlüssel |
| `MAIL_FROM` | Text | `onboarding@resend.dev` |

Speichern, der Worker startet neu.

### 5.4 Prüfen

Anmelden. Unten links in der Seitenleiste steht unter „Benachrichtigungen an" ein grünes
**✓ aktiv**.

Echter Test: PDF hochladen, Unterschriftsfeld setzen, Link erzeugen, Link selbst öffnen,
unterschreiben. Sekunden später liegt die Benachrichtigung in Ihrem Postfach — mit dem
unterschriebenen PDF im Anhang.

Kommt nichts an: bei Resend unter **Logs** nachsehen. Eine Ablehnung heißt praktisch immer, dass
Empfänger- und Kontoadresse nicht übereinstimmen.

### 5.5 Später: mit eigener Domain

Sobald Sie eine Domain haben, wird auch der Versand an Kunden möglich:

1. Domain bei Cloudflare registrieren oder eine vorhandene dort einbinden.
2. Bei Resend unter **Domains** → **Add Domain** eintragen. Resend zeigt DNS-Einträge an (MX, SPF,
   DKIM). Bei Cloudflare unter **DNS** → **Datensatz hinzufügen** eintragen — bei diesen Einträgen
   muss die orange Wolke ausgeschaltet sein („DNS only"), sonst schlägt die Prüfung fehl.
   Dann bei Resend **Verify DNS Records**.
3. In Cloudflare `MAIL_FROM` auf eine Adresse dieser Domain ändern, etwa
   `unterschrift@ihre-domain.de`.
4. Auf github.com in `wrangler.jsonc` bei `LINK_ONLY` den Wert von `"1"` auf `"0"` setzen und
   **Commit changes**.

Danach erscheint im Versand-Fenster wieder der komplette E-Mail-Teil mit Anrede, Adresse, Vorschau
und dem Knopf **Direkt senden**.

Der Gratis-Tarif von Resend erlaubt rund 3.000 Nachrichten im Monat bei etwa 100 am Tag.

---

## Schritt 6 · Eigene Domain

Eine Adresse wie `unterschrift.ihre-domain.de` wirkt bei Kunden deutlich vertrauenswürdiger als
`ressler-dokumente.workers.dev`.

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**. Wenn die Domain schon bei
Cloudflare liegt, ist der DNS-Eintrag und das HTTPS-Zertifikat in einer Minute erledigt.

---

## Der tägliche Ablauf

1. **Dokument bereitstellen** — entweder ein PDF hochladen (mehrere werden zusammengeführt) oder
   unter **Dokument erstellen** eines im Baukasten schreiben: Kopfzeile, Überschrift, Absätze,
   Zwischenüberschriften, Aufzählungen und Unterschriftszeilen. Letztere werden beim Erzeugen
   automatisch zu fertigen Feldern — im Editor müssen Sie dann nichts mehr platzieren.
   Wiederkehrende Schreiben sichern Sie über **Als Vorlage sichern** und laden sie beim nächsten Mal
   mit einem Klick.
2. **Felder setzen** — Werkzeug wählen, Rechteck aufziehen, beschriften.
3. **Übergeben** — E-Mail senden oder Link kopieren. Sprache Deutsch oder Ungarisch; der Kunde kann
   selbst umschalten.
4. **Benachrichtigung abwarten** — bei jeder Unterschrift geht eine Mail an Sie raus.
5. **Sichern und löschen** — im Vorgang beide Dateien herunterladen. Erst wenn beide Haken gesetzt
   sind, wird der Löschen-Knopf aktiv. Löschen Sie erst, wenn Sie die Dateien geöffnet und geprüft
   haben.

---

## Hinweisfeld, Download vorab und ungarische Übersetzung

Alle drei Funktionen stellen Sie im **Editor** ein, also dort, wo Sie auch die Felder setzen. Sie
finden sie rechts in der Seitenleiste, sobald kein Feld ausgewählt ist.

**Großer Hinweis.** Was Sie in das Feld „Großer Hinweis für den Kunden" schreiben, erscheint auf der
Signaturseite groß, grün und mittig ganz oben — und bleibt beim Scrollen stehen. Bleibt das Feld leer,
erscheint nichts. Der Hinweis wird nicht ins PDF übernommen.

**Download vor der Unterschrift.** Der Kunde hat oben rechts immer den Knopf „Dokument
herunterladen". Vor der Unterschrift bekommt er das Original, danach die unterschriebene Fassung.
Beides wird im Protokoll vermerkt. Dafür ist nichts einzustellen.

**Ungarische Übersetzung.** Klicken Sie auf **Übersetzung erstellen**. Seite für Seite wird der Text
ausgelesen und von Cloudflares KI ins Ungarische übersetzt; bei einem fünfseitigen Dokument dauert
das etwa eine halbe Minute. Danach öffnet sich die Übersetzung zur Prüfung, und Sie können jede
Seite direkt korrigieren.

Prüfen Sie vor allem Beträge, Daten und Fachbegriffe. Maschinelle Übersetzungen von
Versicherungstexten sind gut, aber nicht fehlerfrei.

Mit dem Schalter **Für den Kunden freigeben** erscheint auf der Signaturseite der Knopf
„Magyar fordítás". Der Kunde liest die Übersetzung in einem eigenen Fenster und kann sie als PDF
speichern. Über der Übersetzung steht auf Ungarisch und im PDF zusätzlich auf Deutsch, dass es sich um
eine unverbindliche Übersetzung handelt und nur das deutsche Original gilt. Dass der Kunde die
Übersetzung geöffnet hat, wird im Protokoll vermerkt.

Einzurichten ist dafür nichts — die Verbindung zu Workers AI steht bereits in `wrangler.jsonc`. Der
Gratis-Tarif erlaubt rund 250 übersetzte Seiten am Tag. Ist das Kontingent erschöpft, sagt Ihnen die
Anwendung das; es setzt sich täglich um 02:00 Uhr deutscher Zeit zurück.

**Grenzen:** Gescannte PDFs enthalten keinen lesbaren Text, sondern nur ein Bild davon. Solche Seiten
werden übersprungen. Bei Dokumenten aus dem Baukasten und bei digital erzeugten PDFs von
Versicherern funktioniert es zuverlässig.

---

## Was das kostet

Alles im Gratis-Tarif: 100.000 Worker-Aufrufe am Tag, 10 GB R2-Speicher. Verschicken Sie über Ihr eigenes Postfach, kommt gar kein weiterer Dienst hinzu.
Ein kompletter Signaturvorgang verbraucht rund 30 Aufrufe. Sie müssten etwa 3.000 Vorgänge am Tag
abwickeln, um an eine Grenze zu stoßen.

---

## Sicherung — bitte lesen

Die Anwendung ist bewusst kein Archiv. **Die einzigen dauerhaften Kopien Ihrer unterschriebenen
Dokumente sind die, die Sie herunterladen.** Legen Sie sie sofort in der Kundenakte ab und beziehen
Sie sie in Ihre normale Datensicherung ein — für Versicherungsunterlagen gelten Aufbewahrungsfristen
von bis zu zehn Jahren.

Wenn Sie es vorziehen, dass die Dokumente länger auf dem Server bleiben, ändern Sie
`RETENTION_DAYS`. Das geht bequem im Browser: auf github.com die Datei `wrangler.jsonc` öffnen,
oben rechts auf das Stift-Symbol, die Zahl ändern, **Commit changes**. Cloudflare baut die neue
Fassung von selbst — nach ein bis zwei Minuten ist sie aktiv. Genauso ändern Sie `NOTIFY_EMAIL`,
falls die Benachrichtigungen einmal woandershin sollen.

---

## Wenn etwas nicht funktioniert

**Weiße Seite.** Im Browser F12 drücken, Reiter Konsole. Meldet sie einen Fehler bei
`/api/session`, läuft der Worker nicht — prüfen Sie im Dashboard unter **Logs**, ob die Secrets
gesetzt sind.

**„Zugangsdaten fehlen".** `ADMIN_EMAIL` oder `ADMIN_PASSWORD` fehlt oder ist als Text statt als
Secret angelegt.

**Upload bricht ab.** Prüfen Sie, ob der R2-Bucket wirklich `ressler-dokumente` heißt — der Name in
`wrangler.jsonc` muss exakt übereinstimmen.

**E-Mail kommt nicht an.** Zuerst im Spam-Ordner nachsehen, dann bei Resend unter **Logs**, ob die
Nachricht angenommen wurde. Steht dort eine Ablehnung, ist meist die Absenderdomain noch nicht
bestätigt oder `MAIL_FROM` gehört nicht zur bestätigten Domain.
