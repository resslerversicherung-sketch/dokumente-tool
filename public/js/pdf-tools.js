/**
 * PDF-Werkzeuge, die im Browser laufen.
 *
 * Auf Cloudflare hat ein Worker im Gratis-Tarif nur 10 ms Rechenzeit pro
 * Anfrage — zu wenig, um ein PDF zu verändern. Deshalb passiert die Arbeit
 * hier: beim Vermittler das Zusammenführen und das Protokoll, beim Kunden
 * das Einstempeln der Unterschrift.
 */

const PDFTools = (() => {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  let fontCache = null;

  async function loadFonts(pdfDoc) {
    pdfDoc.registerFontkit(fontkit);
    if (!fontCache) {
      const [regular, bold] = await Promise.all([
        fetch('/fonts/DejaVuSans.ttf').then((r) => r.arrayBuffer()),
        fetch('/fonts/DejaVuSans-Bold.ttf').then((r) => r.arrayBuffer()),
      ]);
      fontCache = { regular, bold };
    }
    return {
      regular: await pdfDoc.embedFont(fontCache.regular, { subset: true }),
      bold: await pdfDoc.embedFont(fontCache.bold, { subset: true }),
    };
  }

  /** Mehrere PDFs in der gegebenen Reihenfolge zu einem Dokument verbinden. */
  async function merge(buffers) {
    if (buffers.length === 1) {
      // Trotzdem einmal laden, damit ein defektes PDF sofort auffällt.
      const check = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
      return { bytes: new Uint8Array(buffers[0]), pageCount: check.getPageCount() };
    }
    const out = await PDFDocument.create();
    for (const buffer of buffers) {
      const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    out.setProducer('RESSLER-DOKUMENTE');
    out.setCreationDate(new Date());
    return { bytes: await out.save(), pageCount: out.getPageCount() };
  }

  async function pageCount(buffer) {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  }

  /**
   * Felder in das PDF stempeln. Koordinaten sind relativ (0..1) zur
   * sichtbaren Seite, Ursprung oben links.
   */
  async function stamp(buffer, fields, values) {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    let font = null;
    const pages = pdfDoc.getPages();

    for (const field of fields) {
      if (field.type === 'note') continue; // Hinweise erscheinen nie im PDF
      const value = values[field.id];
      if (value === undefined || value === null || value === '') continue;
      const page = pages[field.page];
      if (!page) continue;

      const { width: pw, height: ph } = page.getSize();
      const rotation = page.getRotation().angle % 360;
      const swapped = rotation === 90 || rotation === 270;
      const visW = swapped ? ph : pw;
      const visH = swapped ? pw : ph;

      const w = field.w * visW;
      const h = field.h * visH;
      const left = field.x * visW;
      const top = field.y * visH;

      const place = (dx, dy) => {
        const px = left + dx;
        const py = top + dy;
        switch (rotation) {
          case 90: return { x: py, y: px };
          case 180: return { x: pw - px, y: py };
          case 270: return { x: ph - py, y: pw - px };
          default: return { x: px, y: ph - py };
        }
      };

      if (field.type === 'signature') {
        const png = await pdfDoc.embedPng(String(value));
        const scale = Math.min(w / png.width, h / png.height);
        const dw = png.width * scale;
        const dh = png.height * scale;
        const pos = place((w - dw) / 2, (h - dh) / 2 + dh);
        page.drawImage(png, {
          x: pos.x, y: pos.y, width: dw, height: dh,
          rotate: PDFLib.degrees(rotation === 0 ? 0 : 360 - rotation),
        });
      } else {
        if (!font) font = (await loadFonts(pdfDoc)).regular;
        const text = String(value);
        let size = Math.min(14, Math.max(8, h * 0.55));
        while (size > 6 && font.widthOfTextAtSize(text, size) > w) size -= 0.5;
        const pos = place(2, h - Math.max(2, (h - size) / 2));
        page.drawText(text, {
          x: pos.x, y: pos.y, size, font,
          color: rgb(0.05, 0.05, 0.1),
          rotate: PDFLib.degrees(rotation === 0 ? 0 : 360 - rotation),
        });
      }
    }

    return pdfDoc.save();
  }

  /* ------------------------------------------------------- Protokoll --- */

  const EVENT_LABELS = {
    created: 'Dokument angelegt',
    fields_saved: 'Unterschriftsfelder definiert',
    link_created: 'Signaturlink erzeugt',
    email_sent: 'E-Mail an Unterzeichner versendet',
    opened: 'Dokument vom Unterzeichner geöffnet',
    field_signed: 'Feld unterschrieben',
    completed: 'Signaturvorgang abgeschlossen',
    downloaded: 'Dokument heruntergeladen',
    translation_created: 'Ungarische Übersetzung erstellt',
    translation_edited: 'Übersetzung vom Vermittler überarbeitet',
    translation_viewed: 'Übersetzung vom Unterzeichner geöffnet',
  };

  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const tz = -d.getTimezoneOffset() / 60;
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (UTC${tz >= 0 ? '+' : ''}${tz})`;
  }

  function origin(ev) {
    const parts = [ev.city, ev.region, ev.country].filter(Boolean);
    const place = parts.length ? parts.join(', ') : '';
    return [place, ev.network].filter(Boolean).join(' · ');
  }

  /** Revisionssicheres Protokoll als PDF. */
  async function protocol(doc) {
    const pdfDoc = await PDFDocument.create();
    const { regular, bold } = await loadFonts(pdfDoc);
    const A4 = [595.28, 841.89];
    const margin = 48;
    const maxWidth = A4[0] - margin * 2;
    let page = pdfDoc.addPage(A4);
    let cursor = A4[1] - margin;

    const need = (space) => {
      if (cursor - space < margin) { page = pdfDoc.addPage(A4); cursor = A4[1] - margin; }
    };

    const line = (text, { size = 9.5, font = regular, color = rgb(0.12, 0.12, 0.15), indent = 0, gap = 14 } = {}) => {
      const width = maxWidth - indent;
      let current = '';
      const flush = () => {
        need(gap);
        page.drawText(current, { x: margin + indent, y: cursor - size, size, font, color });
        cursor -= gap;
        current = '';
      };
      for (let word of String(text).split(/\s+/)) {
        while (font.widthOfTextAtSize(word, size) > width) {
          let cut = word.length;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
          if (current) flush();
          current = word.slice(0, cut);
          flush();
          word = word.slice(cut);
        }
        const test = current ? current + ' ' + word : word;
        if (font.widthOfTextAtSize(test, size) > width && current) { flush(); current = word; }
        else current = test;
      }
      if (current) flush();
    };

    const rule = () => {
      need(12);
      page.drawLine({
        start: { x: margin, y: cursor - 2 },
        end: { x: A4[0] - margin, y: cursor - 2 },
        thickness: 0.6, color: rgb(0.82, 0.82, 0.86),
      });
      cursor -= 16;
    };

    line('SIGNATURPROTOKOLL', { size: 8, font: bold, color: rgb(0.45, 0.45, 0.5), gap: 12 });
    line(doc.title, { size: 17, font: bold, color: rgb(0.06, 0.06, 0.08), gap: 24 });
    rule();

    line('Vorgang', { size: 11, font: bold, gap: 18 });
    const meta = [
      ['Dokument-ID', doc.id],
      ['Titel', doc.title],
      ['Seiten', String(doc.pageCount || '—')],
      ['Status', doc.status === 'completed' ? 'abgeschlossen' : doc.status],
      ['Unterzeichner', `${doc.signer?.name || '—'}${doc.signer?.email ? ' <' + doc.signer.email + '>' : ''}`],
      ['Sprache der Signaturseite', doc.language === 'hu' ? 'Ungarisch' : 'Deutsch'],
      ['Angelegt am', fmt(doc.createdAt)],
      ['Abgeschlossen am', doc.completedAt ? fmt(doc.completedAt) : '—'],
      ['Prüfsumme Original (SHA-256)', doc.hashOriginal || '—'],
      ['Prüfsumme signiert (SHA-256)', doc.hashSigned || '—'],
    ];
    for (const [key, value] of meta) {
      need(14);
      page.drawText(key, { x: margin, y: cursor - 9, size: 9, font: bold, color: rgb(0.35, 0.35, 0.4) });
      line(value, { indent: 180, gap: 14 });
    }
    cursor -= 8;
    rule();

    line('Unterschriften', { size: 11, font: bold, gap: 18 });
    const signatures = (doc.fields || []).filter((f) => f.type === 'signature');
    if (!signatures.length) line('Keine Unterschriftsfelder definiert.', { color: rgb(0.4, 0.4, 0.45) });
    for (const field of signatures) {
      const ev = (doc.events || []).find((e) => e.type === 'field_signed' && e.fieldId === field.id);
      need(60);
      line(`${field.label || 'Unterschrift'} — Seite ${field.page + 1}`, { font: bold, size: 10, gap: 14 });
      line(`Zeitpunkt: ${ev ? fmt(ev.at) : 'nicht unterschrieben'}`, { indent: 12, gap: 13 });
      line(`Methode: ${ev?.method === 'typed' ? 'getippte Unterschrift' : 'freihändig gezeichnet (Maus/Touch/Stift)'}`, { indent: 12, gap: 13 });
      if (ev?.ip) line(`Von IP ${ev.ip}${origin(ev) ? ' · ' + origin(ev) : ''}`, { indent: 12, gap: 13 });
      if (ev?.value) {
        try {
          const png = await pdfDoc.embedPng(ev.value);
          const scale = Math.min(150 / png.width, 44 / png.height);
          need(png.height * scale + 10);
          page.drawImage(png, {
            x: margin + 12, y: cursor - png.height * scale,
            width: png.width * scale, height: png.height * scale,
          });
          cursor -= png.height * scale + 10;
        } catch (_) { /* Bild optional */ }
      }
      cursor -= 6;
    }
    cursor -= 4;
    rule();

    line('Ereignisprotokoll', { size: 11, font: bold, gap: 18 });
    for (const ev of doc.events || []) {
      need(46);
      line(`${fmt(ev.at)}  ·  ${EVENT_LABELS[ev.type] || ev.type}`, { font: bold, size: 9.5, gap: 13 });
      const details = [];
      if (ev.detail) details.push(ev.detail);
      if (ev.ip) details.push('IP-Adresse: ' + ev.ip);
      if (origin(ev)) details.push('Herkunft: ' + origin(ev));
      if (ev.timezone) details.push('Zeitzone des Geräts: ' + ev.timezone);
      if (ev.ua) details.push('Browser: ' + ev.ua);
      for (const d of details) line(d, { indent: 12, size: 8.5, color: rgb(0.38, 0.38, 0.43), gap: 12 });
      cursor -= 4;
    }

    need(60);
    cursor -= 10;
    rule();
    line(
      'Dieses Protokoll wurde automatisch erzeugt und dokumentiert den vollständigen Signaturvorgang. '
      + 'Die Prüfsummen weisen nach, dass das signierte Dokument seit dem Abschluss unverändert ist. '
      + 'Die Herkunftsangaben stammen aus dem Netzwerk von Cloudflare, über das die Unterschrift eingegangen ist. '
      + 'Erstellt am ' + fmt(new Date().toISOString()) + '.',
      { size: 8, color: rgb(0.45, 0.45, 0.5), gap: 11 }
    );

    return pdfDoc.save();
  }

  /** Bytes im Browser als Datei speichern. */
  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }


  /* ------------------------------------------------------- Baukasten --- */

  /**
   * Aus dem Baukasten ein PDF erzeugen.
   * Liefert das Dokument und die dazu passenden Unterschriftsfelder,
   * damit im Editor nichts mehr platziert werden muss.
   */
  async function build(spec) {
    const pdfDoc = await PDFDocument.create();
    const { regular, bold } = await loadFonts(pdfDoc);
    const A4 = [595.28, 841.89];
    const margin = 56;
    const maxWidth = A4[0] - margin * 2;

    let page = pdfDoc.addPage(A4);
    let cursor = A4[1] - margin;
    const fields = [];

    const newPage = () => { page = pdfDoc.addPage(A4); cursor = A4[1] - margin; };
    const need = (space) => { if (cursor - space < margin) newPage(); };

    const wrap = (text, font, size, width) => {
      const lines = [];
      for (const paragraph of String(text).split('\n')) {
        if (!paragraph.trim()) { lines.push(''); continue; }
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
          const test = line ? line + ' ' + word : word;
          if (font.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = word; }
          else line = test;
        }
        if (line) lines.push(line);
      }
      return lines;
    };

    const writeBlock = (text, font, size, lineHeight, color = rgb(0.1, 0.1, 0.12)) => {
      for (const line of wrap(text, font, size, maxWidth)) {
        need(lineHeight);
        if (line) page.drawText(line, { x: margin, y: cursor - size, size, font, color });
        cursor -= lineHeight;
      }
    };

    if (spec.header) {
      writeBlock(spec.header, regular, 9, 13, rgb(0.45, 0.45, 0.5));
      need(14);
      page.drawLine({
        start: { x: margin, y: cursor - 4 },
        end: { x: A4[0] - margin, y: cursor - 4 },
        thickness: 0.75, color: rgb(0.8, 0.8, 0.84),
      });
      cursor -= 26;
    }

    if (spec.title) {
      writeBlock(spec.title, bold, 20, 26, rgb(0.06, 0.06, 0.08));
      cursor -= 8;
    }

    for (const block of spec.blocks || []) {
      if (!String(block.text || '').trim()) continue;
      if (block.type === 'heading') {
        cursor -= 10;
        writeBlock(block.text, bold, 13, 19, rgb(0.06, 0.06, 0.08));
        cursor -= 2;
      } else if (block.type === 'bullets') {
        for (const item of String(block.text).split('\n').filter((l) => l.trim())) {
          const lines = wrap('•  ' + item.trim(), regular, 10.5, maxWidth - 12);
          lines.forEach((line, i) => {
            need(16);
            page.drawText(line, {
              x: margin + (i === 0 ? 0 : 14), y: cursor - 10.5,
              size: 10.5, font: regular, color: rgb(0.1, 0.1, 0.12),
            });
            cursor -= 16;
          });
        }
        cursor -= 8;
      } else {
        writeBlock(block.text, regular, 10.5, 16);
        cursor -= 8;
      }
    }

    for (const sig of spec.signatures || []) {
      need(96);
      const boxTop = cursor - 8;
      const boxH = 58;
      const boxW = 240;
      page.drawLine({
        start: { x: margin, y: boxTop - boxH },
        end: { x: margin + boxW, y: boxTop - boxH },
        thickness: 0.75, color: rgb(0.7, 0.7, 0.75),
      });
      page.drawText(sig.label || 'Unterschrift', {
        x: margin, y: boxTop - boxH - 13,
        size: 8.5, font: regular, color: rgb(0.45, 0.45, 0.5),
      });
      fields.push({
        page: pdfDoc.getPageCount() - 1,
        type: 'signature',
        label: sig.label || 'Unterschrift',
        filledBy: 'customer',
        required: true,
        x: margin / A4[0],
        y: (A4[1] - boxTop) / A4[1],
        w: boxW / A4[0],
        h: boxH / A4[1],
      });

      if (sig.placeDate) {
        const px = margin + boxW + 40;
        const pw = A4[0] - margin - px;
        page.drawLine({
          start: { x: px, y: boxTop - boxH },
          end: { x: px + pw, y: boxTop - boxH },
          thickness: 0.75, color: rgb(0.7, 0.7, 0.75),
        });
        page.drawText('Ort, Datum', {
          x: px, y: boxTop - boxH - 13,
          size: 8.5, font: regular, color: rgb(0.45, 0.45, 0.5),
        });
        fields.push({
          page: pdfDoc.getPageCount() - 1,
          type: 'place_date',
          label: 'Ort, Datum',
          filledBy: sig.placeDateBy === 'admin' ? 'admin' : 'customer',
          value: sig.placeDateValue || '',
          required: true,
          x: px / A4[0],
          y: (A4[1] - boxTop + 18) / A4[1],
          w: pw / A4[0],
          h: 26 / A4[1],
        });
      }
      cursor -= 96;
    }

    return { bytes: await pdfDoc.save(), pageCount: pdfDoc.getPageCount(), fields };
  }


  /* ------------------------------------------------- Text auslesen --- */

  /** Text einer Seite aus einem mit pdf.js geladenen Dokument. */
  async function pageText(pdfJsDoc, index) {
    const page = await pdfJsDoc.getPage(index + 1);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      text += item.str || '';
      if (item.hasEOL) text += '\n';
      else if (item.str && !item.str.endsWith(' ')) text += ' ';
    }
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ------------------------------------------ Übersetzung als PDF --- */

  async function translationPdf({ title, pages, note, pageLabel }) {
    const pdfDoc = await PDFDocument.create();
    const { regular, bold } = await loadFonts(pdfDoc);
    const A4 = [595.28, 841.89];
    const margin = 56;
    const maxWidth = A4[0] - margin * 2;
    let page = pdfDoc.addPage(A4);
    let cursor = A4[1] - margin;
    const need = (h) => { if (cursor - h < margin) { page = pdfDoc.addPage(A4); cursor = A4[1] - margin; } };

    const write = (text, font, size, lh, color = rgb(0.1, 0.1, 0.12)) => {
      for (const paragraph of String(text).split('\n')) {
        if (!paragraph.trim()) { cursor -= lh * 0.6; continue; }
        let line = '';
        const flush = () => { need(lh); page.drawText(line, { x: margin, y: cursor - size, size, font, color }); cursor -= lh; line = ''; };
        for (const word of paragraph.split(/\s+/)) {
          const test = line ? line + ' ' + word : word;
          if (font.widthOfTextAtSize(test, size) > maxWidth && line) { flush(); line = word; }
          else line = test;
        }
        if (line) flush();
      }
    };

    write(title, bold, 17, 23, rgb(0.06, 0.06, 0.08));
    cursor -= 6;
    // Hinweis in einem getönten Kasten
    const noteLines = [];
    {
      let line = '';
      for (const word of String(note).split(/\s+/)) {
        const test = line ? line + ' ' + word : word;
        if (bold.widthOfTextAtSize(test, 9.5) > maxWidth - 20 && line) { noteLines.push(line); line = word; }
        else line = test;
      }
      if (line) noteLines.push(line);
    }
    const boxH = noteLines.length * 14 + 16;
    need(boxH + 10);
    page.drawRectangle({
      x: margin, y: cursor - boxH, width: maxWidth, height: boxH,
      color: rgb(1, 0.97, 0.9), borderColor: rgb(0.95, 0.75, 0.35), borderWidth: 0.8,
    });
    noteLines.forEach((l, i) => page.drawText(l, {
      x: margin + 10, y: cursor - 20 - i * 14, size: 9.5, font: bold, color: rgb(0.45, 0.28, 0),
    }));
    cursor -= boxH + 18;

    pages.forEach((text, i) => {
      need(40);
      write(pageLabel(i + 1), bold, 11, 18, rgb(0.35, 0.35, 0.4));
      write(text || '—', regular, 10.5, 15.5);
      cursor -= 12;
    });
    return pdfDoc.save();
  }

  /** SHA-256 als Hexstring — belegt später, dass die Datei unverändert ist. */
  async function hash(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { merge, stamp, protocol, pageCount, download, hash, build, pageText, translationPdf };
})();
