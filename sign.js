/* RESSLER-DOKUMENTE — Signaturstrecke für den Unterzeichner */
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

const token = location.pathname.split('/').pop();
const app = document.getElementById('app');

const T = {
  de: {
    heading: 'Dokument zur Unterschrift',
    intro: 'Bitte lesen Sie das Dokument und unterschreiben Sie an den markierten Stellen.',
    start: 'Unterschrift erfassen',
    next: 'Weiter zur nächsten Stelle',
    finish: 'Unterschreiben und abschließen',
    remaining: (n) => `Noch ${n} offene Stelle${n === 1 ? '' : 'n'}`,
    allDone: 'Alle Stellen ausgefüllt',
    signHere: 'Hier unterschreiben',
    fillHere: 'Hier eintragen',
    padTitle: 'Ihre Unterschrift',
    padHint: 'Zeichnen Sie mit der Maus, dem Finger oder einem Stift in das Feld.',
    draw: 'Zeichnen',
    type: 'Tippen',
    typeName: 'Ihr Name',
    clear: 'Löschen',
    apply: 'Übernehmen',
    cancel: 'Abbrechen',
    inputTitle: 'Eingabe',
    place: 'Ort',
    date: 'Datum',
    placeDate: 'Ort, Datum',
    today: 'Heute einsetzen',
    thanksTitle: 'Vielen Dank für Ihre Unterschriften.',
    thanksBody: 'Ihr Vermittler bearbeitet jetzt den Vorgang weiter und meldet sich in Kürze bei Ihnen.',
    download: 'Unterschriebenes Dokument herunterladen',
    close: 'Schließen',
    completedTitle: 'Dieser Vorgang ist abgeschlossen.',
    completedBody: 'Das unterschriebene Dokument steht weiterhin zum Download bereit.',
    notFound: 'Dieser Link ist nicht mehr gültig.',
    notFoundBody: 'Bitte wenden Sie sich an Ihren Versicherungsvermittler.',
    saving: 'Wird abgeschlossen …',
    missing: 'Es fehlt noch eine Eingabe.',
    error: 'Etwas hat nicht funktioniert. Bitte erneut versuchen.',
    secured: 'Zeitstempel und IP-Adresse werden zum Nachweis protokolliert.',
  },
  hu: {
    heading: 'Aláírandó dokumentum',
    intro: 'Kérjük, olvassa el a dokumentumot, és írja alá a megjelölt helyeken.',
    start: 'Aláírás megadása',
    next: 'Tovább a következő helyre',
    finish: 'Aláírás és befejezés',
    remaining: (n) => `Még ${n} kitöltendő hely`,
    allDone: 'Minden hely kitöltve',
    signHere: 'Írja alá itt',
    fillHere: 'Töltse ki itt',
    padTitle: 'Az Ön aláírása',
    padHint: 'Rajzoljon egérrel, ujjal vagy tollal a mezőbe.',
    draw: 'Rajzolás',
    type: 'Gépelés',
    typeName: 'Az Ön neve',
    clear: 'Törlés',
    apply: 'Alkalmaz',
    cancel: 'Mégse',
    inputTitle: 'Beírás',
    place: 'Hely',
    date: 'Dátum',
    placeDate: 'Hely, dátum',
    today: 'Mai dátum beírása',
    thanksTitle: 'Köszönjük az aláírásokat.',
    thanksBody: 'Közvetítője most továbbviszi az ügyet, és hamarosan jelentkezik Önnél.',
    download: 'Aláírt dokumentum letöltése',
    close: 'Bezárás',
    completedTitle: 'Ez a folyamat lezárult.',
    completedBody: 'Az aláírt dokumentum továbbra is letölthető.',
    notFound: 'Ez a link már nem érvényes.',
    notFoundBody: 'Kérjük, forduljon biztosítási közvetítőjéhez.',
    saving: 'Befejezés folyamatban …',
    missing: 'Még hiányzik egy adat.',
    error: 'Valami nem sikerült. Kérjük, próbálja újra.',
    secured: 'Az időbélyeget és az IP-címet bizonyítékként rögzítjük.',
  },
};

let t = T.de;
let doc = null;
const values = {};
const methods = {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function modal(html, { wide, dismissable = true } = {}) {
  const back = document.createElement('div');
  back.className = 'backdrop';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}">${html}</div>`;
  if (dismissable) {
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  }
  function close() { back.remove(); }
  document.body.appendChild(back);
  return { el: back.firstElementChild, close };
}

/* --------------------------------------------------------------- Start --- */

(async function init() {
  let data;
  try {
    const res = await fetch('/api/sign/' + token);
    if (!res.ok) throw new Error('not_found');
    data = await res.json();
  } catch (_) {
    app.innerHTML = `<div style="display:grid;place-items:center;min-height:100vh;padding:24px">
      <div class="card" style="max-width:420px;text-align:center;padding:38px">
        <h2 style="margin-bottom:8px">${t.notFound}</h2>
        <p class="small muted">${t.notFoundBody}</p>
      </div></div>`;
    return;
  }
  doc = data;
  t = T[doc.language] || T.de;
  document.documentElement.lang = doc.language || 'de';
  document.title = doc.title;
  renderShell();
  await renderPages();
  if (doc.completed) showCompleted();
})();

function customerFields() {
  return (doc.fields || []).filter((f) => f.filledBy === 'customer' && f.type !== 'note');
}
function openFields() {
  return customerFields().filter((f) => !values[f.id]);
}

function renderShell() {
  app.innerHTML = `
    <div class="topbar">
      <div class="brand" style="padding:0;gap:9px">
        <div class="mark" style="width:26px;height:26px;border-radius:8px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 17c3-1 5-10 8-10s1 7 3.5 7S19 12 19 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>
      </div>
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.title)}</div>
        <div class="tiny muted" id="introLine">${t.intro}</div>
      </div>
      <a class="btn small" id="dlTop" href="/api/sign/${token}/file" style="display:${doc.completed ? 'inline-flex' : 'none'}">${t.download}</a>
    </div>
    <div class="docstage" id="stage"><div style="display:grid;place-items:center;padding:70px"><div class="spinner dark"></div></div></div>
    <div class="actionbar" id="actionbar" style="display:${doc.completed ? 'none' : 'block'}">
      <div class="actionbar-inner">
        <div class="lang-switch" id="langSwitch" title="Sprache · Nyelv">
          <button data-l="de" aria-pressed="${(doc.language || 'de') === 'de'}">DE</button>
          <button data-l="hu" aria-pressed="${doc.language === 'hu'}">HU</button>
        </div>
        <div style="min-width:0;flex:1">
          <div style="font-size:13.5px;font-weight:500" id="barLabel">${t.remaining(customerFields().length)}</div>
          <div class="tiny muted" id="securedLine" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.secured}</div>
        </div>
        <div class="progress"><i id="bar" style="width:0%"></i></div>
        <button class="btn primary" id="mainAction">${t.start}</button>
      </div>
    </div>`;

  // onclick statt addEventListener: updateBar() ersetzt den Handler,
  // sonst würde am Ende sowohl goToNext als auch submit auslösen.
  document.getElementById('mainAction').onclick = goToNext;

  document.getElementById('langSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setLanguage(btn.dataset.l);
  });
}

/** Sprache der Bedienoberfläche wechseln. Das PDF bleibt unverändert. */
function setLanguage(lang) {
  if (!T[lang]) return;
  t = T[lang];
  doc.language = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll('#langSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.l === lang)));
  const intro = document.getElementById('introLine');
  if (intro) intro.textContent = t.intro;
  const secured = document.getElementById('securedLine');
  if (secured) secured.textContent = t.secured;
  const dl = document.getElementById('dlTop');
  if (dl) dl.textContent = t.download;
  // Offene Felder tragen Platzhaltertexte in der Oberflächensprache.
  paintTargets();
}

async function renderPages() {
  const stage = document.getElementById('stage');
  const pdf = await pdfjsLib.getDocument(`/api/sign/${token}/file?inline=1`).promise;
  stage.innerHTML = '';
  const width = Math.min(920, window.innerWidth - 32);

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.page = String(i);
    wrap.appendChild(overlay);
    stage.appendChild(wrap);
  }
  paintTargets();
}

function paintTargets() {
  document.querySelectorAll('.overlay').forEach((o) => (o.innerHTML = ''));
  for (const field of doc.fields || []) {
    const overlay = document.querySelector(`.overlay[data-page="${field.page}"]`);
    if (!overlay) continue;

    if (field.type === 'note') {
      const note = document.createElement('div');
      note.className = 'note-flag';
      note.style.cssText += `left:${field.x * 100}%;top:${field.y * 100}%;width:${field.w * 100}%;min-height:${field.h * 100}%`;
      note.textContent = field.label;
      overlay.appendChild(note);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'sig-target';
    el.style.left = field.x * 100 + '%';
    el.style.top = field.y * 100 + '%';
    el.style.width = field.w * 100 + '%';
    el.style.height = field.h * 100 + '%';
    el.dataset.id = field.id;

    if (field.filledBy === 'admin') {
      el.classList.add('readonly');
      el.style.justifyContent = 'flex-start';
      el.innerHTML = `<span style="padding-left:3px;font-size:13px">${esc(field.value || '')}</span>`;
    } else if (values[field.id]) {
      el.classList.add('done');
      el.innerHTML = field.type === 'signature'
        ? `<img src="${values[field.id]}" alt="">`
        : `<span class="filled-text" style="color:var(--ink);font-weight:400">${esc(values[field.id])}</span>`;
      el.addEventListener('click', () => openField(field));
    } else {
      el.textContent = field.type === 'signature' ? t.signHere : (field.label || t.fillHere);
      el.addEventListener('click', () => openField(field));
    }
    overlay.appendChild(el);
  }
  updateBar();
}

function updateBar() {
  const total = customerFields().length;
  const done = total - openFields().length;
  const bar = document.getElementById('bar');
  if (bar) bar.style.width = (total ? (done / total) * 100 : 100) + '%';
  const label = document.getElementById('barLabel');
  const action = document.getElementById('mainAction');
  if (!label || !action) return;
  if (done >= total) {
    label.textContent = t.allDone;
    action.textContent = t.finish;
    action.onclick = submit;
  } else {
    label.textContent = t.remaining(total - done);
    action.textContent = done === 0 ? t.start : t.next;
    action.onclick = goToNext;
  }
}

function goToNext() {
  const next = openFields()[0];
  if (!next) return submit();
  const el = document.querySelector(`.sig-target[data-id="${next.id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 2900);
    setTimeout(() => openField(next), 420);
  }
}

/* ---------------------------------------------------------- Feldeingabe --- */

function openField(field) {
  if (field.type === 'signature') return openSignaturePad(field);
  return openTextInput(field);
}

function openTextInput(field) {
  const isDate = field.type === 'date';
  const today = new Date().toLocaleDateString(doc.language === 'hu' ? 'hu-HU' : 'de-DE');
  const m = modal(`
    <div class="eyebrow">${t.inputTitle}</div>
    <h2 style="margin:4px 0 18px">${esc(field.label || (field.type === 'place' ? t.place : isDate ? t.date : t.placeDate))}</h2>
    <input type="text" id="txt" value="${esc(values[field.id] || '')}" placeholder="${
      field.type === 'place' ? t.place : isDate ? today : field.type === 'place_date' ? `${t.place}, ${today}` : ''
    }" autofocus>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
      ${field.type !== 'text' ? `<button class="btn small" id="today">${t.today}</button>` : ''}
      <div style="flex:1"></div>
      <button class="btn" id="cancel">${t.cancel}</button>
      <button class="btn primary" id="ok">${t.apply}</button>
    </div>`);

  const input = m.el.querySelector('#txt');
  input.focus();
  const todayBtn = m.el.querySelector('#today');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    input.value = isDate ? today : (input.value.trim() ? input.value.split(',')[0].trim() + ', ' + today : today);
    input.focus();
  });
  m.el.querySelector('#cancel').addEventListener('click', m.close);
  const commit = () => {
    if (!input.value.trim()) return toast(t.missing, 'err');
    values[field.id] = input.value.trim();
    m.close();
    paintTargets();
    setTimeout(() => { if (openFields().length) goToNext(); }, 260);
  };
  m.el.querySelector('#ok').addEventListener('click', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
}

function openSignaturePad(field) {
  const m = modal(`
    <div class="eyebrow">${esc(field.label || t.padTitle)}</div>
    <h2 style="margin:4px 0 6px">${t.padTitle}</h2>
    <p class="small muted" style="margin-bottom:16px">${t.padHint}</p>
    <div class="segmented" id="mode" style="margin-bottom:14px">
      <button data-m="draw" aria-pressed="true">${t.draw}</button>
      <button data-m="type">${t.type}</button>
    </div>
    <div id="drawPane"><canvas class="pad" id="pad" height="200"></canvas></div>
    <div id="typePane" style="display:none">
      <input type="text" id="typedName" placeholder="${t.typeName}" value="${esc(doc.signer?.name || '')}">
      <div class="pad" style="height:120px;display:grid;place-items:center;margin-top:12px">
        <span class="typed-preview" id="typedPreview" style="color:var(--ink)"></span>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:18px;align-items:center">
      <button class="btn small" id="clear">${t.clear}</button>
      <div style="flex:1"></div>
      <button class="btn" id="cancel">${t.cancel}</button>
      <button class="btn primary" id="ok">${t.apply}</button>
    </div>`, { wide: true });

  const canvas = m.el.querySelector('#pad');
  const ctx = canvas.getContext('2d');
  let mode = 'draw';
  let hasInk = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const sizeCanvas = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 200 * dpr;
    canvas.style.height = '200px';
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b0b18';
  };
  requestAnimationFrame(sizeCanvas);

  let drawing = false;
  let last = null;
  const point = (e) => {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };
  const start = (e) => { e.preventDefault(); drawing = true; last = point(e); };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    hasInk = true;
  };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  const typedInput = m.el.querySelector('#typedName');
  const typedPreview = m.el.querySelector('#typedPreview');
  const syncTyped = () => { typedPreview.textContent = typedInput.value; };
  typedInput.addEventListener('input', syncTyped);
  syncTyped();

  m.el.querySelector('#mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    mode = btn.dataset.m;
    m.el.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    m.el.querySelector('#drawPane').style.display = mode === 'draw' ? '' : 'none';
    m.el.querySelector('#typePane').style.display = mode === 'type' ? '' : 'none';
  });

  m.el.querySelector('#clear').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    typedInput.value = '';
    syncTyped();
  });
  m.el.querySelector('#cancel').addEventListener('click', m.close);

  m.el.querySelector('#ok').addEventListener('click', () => {
    let dataUrl = null;
    if (mode === 'draw') {
      if (!hasInk) return toast(t.missing, 'err');
      dataUrl = trimCanvas(canvas);
      methods[field.id] = 'drawn';
    } else {
      const name = typedInput.value.trim();
      if (!name) return toast(t.missing, 'err');
      dataUrl = renderTypedSignature(name);
      methods[field.id] = 'typed';
    }
    values[field.id] = dataUrl;
    m.close();
    paintTargets();
    setTimeout(() => { if (openFields().length) goToNext(); }, 260);
  });
}

/** Weißen Rand um die Zeichnung entfernen, damit die Unterschrift das Feld füllt. */
function trimCanvas(source) {
  const { width, height } = source;
  const data = source.getContext('2d').getImageData(0, 0, width, height).data;
  let top = height, left = width, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right <= left || bottom <= top) return source.toDataURL('image/png');
  const pad = 8;
  left = Math.max(0, left - pad); top = Math.max(0, top - pad);
  right = Math.min(width, right + pad); bottom = Math.min(height, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left;
  out.height = bottom - top;
  out.getContext('2d').drawImage(source, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function renderTypedSignature(name) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = "64px 'Snell Roundhand', 'Apple Chancery', 'Segoe Script', 'Brush Script MT', cursive";
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(name).width) + 40;
  canvas.width = width;
  canvas.height = 110;
  const c = canvas.getContext('2d');
  c.font = font;
  c.fillStyle = '#0b0b18';
  c.textBaseline = 'middle';
  c.fillText(name, 20, 58);
  return canvas.toDataURL('image/png');
}

/* ----------------------------------------------------------- Abschluss --- */

async function submit() {
  const missing = openFields();
  if (missing.length) return goToNext();
  const action = document.getElementById('mainAction');
  action.disabled = true;
  action.innerHTML = `<span class="spinner"></span> ${t.saving}`;
  try {
    // Das Einstempeln passiert hier im Browser. Der Server bekommt das
    // fertige PDF und muss dafür keine Rechenzeit aufwenden.
    const original = await fetch(`/api/sign/${token}/file?inline=1`, { cache: 'no-store' });
    if (!original.ok) throw new Error(t.error);
    const buffer = await original.arrayBuffer();

    const allValues = { ...values };
    for (const f of doc.fields) if (f.filledBy === 'admin' && f.value) allValues[f.id] = f.value;
    const stamped = await PDFTools.stamp(buffer, doc.fields, allValues);

    const form = new FormData();
    form.append('pdf', new Blob([stamped], { type: 'application/pdf' }), 'signed.pdf');
    form.append('payload', JSON.stringify({ values, methods, hash: await PDFTools.hash(stamped) }));

    const res = await fetch(`/api/sign/${token}/complete`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t.error);

    doc.completed = true;
    document.getElementById('actionbar').style.display = 'none';
    document.getElementById('dlTop').style.display = 'inline-flex';
    showThanks();
  } catch (err) {
    toast(err.message || t.error, 'err');
    action.disabled = false;
    action.textContent = t.finish;
  }
}

function showThanks() {
  const m = modal(`
    <div style="text-align:center;padding:8px 4px">
      <div style="width:62px;height:62px;border-radius:50%;background:rgba(52,199,89,.14);display:grid;place-items:center;margin:0 auto 20px">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M5 12.6l4.4 4.4L19 7.4" stroke="#34c759" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h2 style="margin-bottom:10px">${t.thanksTitle}</h2>
      <p class="small muted" style="margin-bottom:26px;line-height:1.6">${t.thanksBody}</p>
      <a class="btn primary large block" id="dl" href="/api/sign/${token}/file">${t.download}</a>
      <button class="btn ghost block" id="close" style="margin-top:10px">${t.close}</button>
    </div>`, { dismissable: false });

  m.el.querySelector('#dl').addEventListener('click', () => {
    fetch(`/api/sign/${token}/downloaded`, { method: 'POST' }).catch(() => {});
  });
  m.el.querySelector('#close').addEventListener('click', m.close);
}

function showCompleted() {
  modal(`
    <div style="text-align:center;padding:8px 4px">
      <h2 style="margin-bottom:10px">${t.completedTitle}</h2>
      <p class="small muted" style="margin-bottom:24px">${t.completedBody}</p>
      <a class="btn primary block" href="/api/sign/${token}/file">${t.download}</a>
      <button class="btn ghost block" id="close" style="margin-top:10px">${t.close}</button>
    </div>`).el.querySelector('#close').addEventListener('click', (e) => e.target.closest('.backdrop').remove());
}
