# RESSLER-DOKUMENTE

Digitale Unterschriften für Versicherungsvermittler, gebaut für den Gratis-Tarif von Cloudflare.

Einrichtung: siehe **ANLEITUNG.md**.

---

## Grundgedanke

Dokumente liegen nur so lange auf dem Server, wie ein Vorgang läuft. Nach der Unterschrift lädt der
Vermittler das PDF und das Protokoll herunter und löscht den Vorgang; was liegen bleibt, wird nach
14 Tagen automatisch entfernt.

Das ist kein Kompromiss, sondern passt zur Plattform: Cloudflare Workers laufen nicht auf einer
festen Maschine und haben kein Dateisystem. Und weil im Gratis-Tarif nur 10 Millisekunden Rechenzeit
pro Anfrage zur Verfügung stehen, passiert alles Rechenintensive im Browser:

| Aufgabe | Wo sie läuft |
|---|---|
| Dokument im Baukasten erzeugen | Browser des Vermittlers |
| Mehrere PDFs zusammenführen | Browser des Vermittlers |
| Dokument anzeigen | Browser (pdf.js) |
| Unterschrift ins PDF stempeln | Browser des Kunden |
| Protokoll-PDF erzeugen | Browser des Vermittlers |
| Text für die Übersetzung auslesen | Browser des Vermittlers |
| Ungarische Übersetzung | Workers AI (Cloudflare) |
| Übersetzung als PDF | Browser des Kunden |
| Prüfsummen berechnen | Browser |
| Speichern, Ausliefern, Protokollieren, E-Mail | Worker |

Der Worker reicht damit fast nur Bytes durch und bleibt weit unter dem Limit.

---

## Aufbau

```
src/worker.js        API, Anmeldung, R2-Ablage, E-Mail, Aufräumlauf
public/
  index.html         Verwaltungsbereich
  sign.html          Signaturseite für den Kunden
  js/admin.js        Vorgänge, Feldeditor, Versand, Download
  js/sign.js         Signaturstrecke, Unterschriftsfeld, Sprachwahl
  js/pdf-tools.js    Baukasten, Zusammenführen, Stempeln, Protokoll — alles im Browser
  vendor/            pdf.js und pdf-lib, lokal ausgeliefert
  fonts/             Schriften für die PDF-Erzeugung
wrangler.jsonc       Cloudflare-Konfiguration
```

Ablage in R2:

```
index.json           Kurzübersicht aller Vorgänge
d/<id>/meta.json     Felder, Unterzeichner, Ereignisprotokoll
d/<id>/original.pdf  Hochgeladenes Dokument
d/<id>/signed.pdf    Unterschriebene Fassung
t/<token>            Verweis vom Signaturlink auf die Vorgangs-ID
d/<id>/translation-hu.json  Ungarische Übersetzung, seitenweise
templates.json       Gespeicherte Dokument- und Feldvorlagen
```

Vorlagen bleiben dauerhaft gespeichert — sie enthalten keine Kundendaten, sondern nur Ihre eigenen
Textbausteine und Feldanordnungen. Vom automatischen Aufräumen sind sie ausgenommen.

---

## Nachweis

Das Protokoll-PDF enthält Zeitstempel, Bilder aller Unterschriften, die Angabe ob gezeichnet oder
getippt, die IP-Adresse sowie Land, Region, Ort, Netzbetreiber und Gerätezeitzone des
Unterzeichners. Diese Herkunftsdaten liefert Cloudflares Netz mit — sie sind aussagekräftiger als
eine reine IP-Notiz.

Die Prüfsummen (SHA-256) werden im Browser berechnet. Sie belegen später, dass das PDF in Ihrer Akte
byteweise dasselbe ist wie das im Protokoll vermerkte.

---

## Örtlich ausprobieren

```bash
npm install
cp .dev.vars.example .dev.vars     # ADMIN_PASSWORD eintragen
npm run dev
```

Dann `http://localhost:8787` öffnen. Die Daten liegen dabei in `.wrangler/` und nicht in R2.

---

## Rechtlicher Rahmen

Das Verfahren erzeugt eine einfache elektronische Signatur nach eIDAS mit ausführlichem Nachweis.
Für Vorgänge, die eine qualifizierte elektronische Signatur verlangen, ist zusätzlich ein
Vertrauensdiensteanbieter nötig.

Sie verarbeiten Unterschriften und IP-Adressen. Nehmen Sie die Anwendung ins Verzeichnis von
Verarbeitungstätigkeiten auf, schließen Sie mit Cloudflare und Resend einen
Auftragsverarbeitungsvertrag und ergänzen Sie Ihre Datenschutzerklärung. Ein R2-Bucket mit Standort
EU vereinfacht das.
