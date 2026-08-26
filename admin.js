/* RESSLER-DOKUMENTE — Verwaltung */
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

const app = document.getElementById('app');

const state = {
  authed: false,
  email: null,
  smtp: false,
  retentionDays: 14,
  notifyEmail: '',
  view: 'list',
  docs: [],
  templates: [],
  doc: null,
  tool: null,
  selected: null,
  zoom: 1,
  pdfDoc: null,
  builder: null,
};

/* ------------------------------------------------------------ Helfer --- */

async function api(path, options = {}) {
  const raw = options.body instanceof FormData
    || options.body instanceof Uint8Array
    || options.body instanceof ArrayBuffer
    || options.body instanceof Blob;
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: raw ? (options.headers || {}) : { 'Content-Type': 'application/json' },
    ...options,
    headers: raw ? (options.headers || {}) : { 'Content-Type': 'application/json' },
    body: raw ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { state.authed = false; render(); throw new Error('Nicht angemeldet'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Es ist ein Fehler aufgetreten.');
  return data;
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS = {
  draft: ['grey', 'Entwurf'],
  ready: ['blue', 'Link bereit'],
  sent: ['blue', 'Versendet'],
  opened: ['amber', 'Geöffnet'],
  completed: ['green', 'Unterschrieben'],
};

const FIELD_TYPES = {
  signature: { label: 'Unterschrift', icon: '✍️' },
  text: { label: 'Textfeld', icon: 'Ab' },
  place: { label: 'Ort', icon: '📍' },
  date: { label: 'Datum', icon: '📅' },
  place_date: { label: 'Ort, Datum', icon: '📍' },
  note: { label: 'Hinweis (nur für den Kunden)', icon: '💬' },
};

const TOOL_ORDER = ['signature', 'place', 'date', 'place_date', 'text', 'note'];

function modal(html, { wide } = {}) {
  const back = document.createElement('div');
  back.className = 'backdrop';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}">${html}</div>`;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); back.remove(); }
  document.body.appendChild(back);
  return { el: back.firstElementChild, close };
}

/* ------------------------------------------------------------- Login --- */

function renderLogin() {
  app.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px">
      <div class="card" style="width:min(390px,100%);padding:34px;box-shadow:var(--shadow)">
        <div class="brand" style="padding:0 0 22px">
          <div class="mark">${lockIcon()}</div>
          <div class="wordmark"><strong>RESSLER</strong><span>Dokumente</span></div>
        </div>
        <h2 style="margin-bottom:6px">Anmelden</h2>
        <p class="small muted" style="margin-bottom:22px">Dieser Bereich ist nur für den Versicherungsvermittler zugänglich.</p>
        <form id="loginForm" autocomplete="on">
          <label class="field"><span>Benutzername (E-Mail)</span>
            <input type="email" id="loginEmail" autocomplete="username" autofocus spellcheck="false"></label>
          <label class="field"><span>Passwort</span>
            <input type="password" id="loginPassword" autocomplete="current-password"></label>
          <div id="loginError" class="small" style="display:none;color:var(--red);margin:-4px 0 14px;line-height:1.45"></div>
          <button class="btn primary block" type="submit" id="loginBtn">Anmelden</button>
        </form>
      </div>
    </div>`;

  const form = document.getElementById('loginForm');
  const errorBox = document.getElementById('loginError');
  const button = document.getElementById('loginBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
      errorBox.textContent = 'Bitte Benutzername und Passwort eingeben.';
      errorBox.style.display = 'block';
      return;
    }
    errorBox.style.display = 'none';
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Anmelden …';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen.');
      state.authed = true;
      state.email = data.email;
      await loadAll();
      render();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginPassword').focus();
      button.disabled = false;
      button.textContent = 'Anmelden';
    }
  });
}

function lockIcon() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4.5 7V5a3.5 3.5 0 017 0v2" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor"/></svg>`; }

/* -------------------------------------------------------------- Shell --- */

function render() {
  if (!state.authed) return renderLogin();
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 17c3-1 5-10 8-10s1 7 3.5 7S19 12 19 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></div>
          <div class="wordmark"><strong>RESSLER</strong><span>Dokumente</span></div>
        </div>
        <button class="nav-item ${state.view === 'list' ? 'active' : ''}" data-nav="list">${navIcon('doc')} Vorgänge</button>
        <div style="flex:1"></div>
        <div class="tiny muted" style="padding:0 10px 10px;line-height:1.5">
          ${state.email ? `Angemeldet als<br><span style="color:var(--ink-2)">${esc(state.email)}</span><br><br>` : ''}
          Benachrichtigungen an<br><span style="color:var(--ink-2)">${esc(state.notifyEmail)}</span>
          ${state.smtp ? '' : '<br><span style="color:var(--amber)">Kein Versanddienst hinterlegt</span>'}
        </div>
        <button class="nav-item" id="logout">${navIcon('out')} Abmelden</button>
      </aside>
      <main class="main" id="main"></main>
    </div>`;

  app.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.nav;
    state.doc = null;
    render();
  }));
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.authed = false;
    state.email = null;
    render();
  });

  const main = document.getElementById('main');
  if (state.view === 'list') renderList(main);
  else if (state.view === 'editor') renderEditor(main);
  else if (state.view === 'detail') renderDetail(main);
}

function navIcon(kind) {
  const paths = {
    doc: '<path d="M4 2h6l4 4v10H4z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10 2v4h4" stroke="currentColor" stroke-width="1.5" fill="none"/>',
    plus: '<path d="M9 3.5v11M3.5 9h11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    star: '<path d="M9 2.5l1.9 4 4.4.6-3.2 3 .8 4.4L9 12.4 5.1 14.5l.8-4.4-3.2-3 4.4-.6z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/>',
    out: '<path d="M7 3H3.5v12H7M11 6l3 3-3 3M6.5 9H14" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  };
  return `<svg width="18" height="18" viewBox="0 0 18 18">${paths[kind]}</svg>`;
}

/* ------------------------------------------------------------- Liste --- */

function sortedDocs() {
  // Erledigte Vorgänge rutschen ans Ende, innerhalb der Gruppen neueste zuerst.
  return state.docs.slice().sort((a, b) => {
    const ad = a.status === 'completed' ? 1 : 0;
    const bd = b.status === 'completed' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt);
  });
}

function renderList(root) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Übersicht</div>
        <h1>Vorgänge</h1>
      </div>
      <button class="btn primary" id="newUpload">PDF hochladen</button>
    </div>
    <div id="rows"></div>`;

  const rows = document.getElementById('rows');
  const list = sortedDocs();
  if (!list.length) {
    rows.innerHTML = `<div class="empty">
      <p style="font-size:16px;color:var(--ink-2);margin-bottom:6px">Noch kein Vorgang</p>
      <p class="small">Laden Sie ein PDF hoch, um zu beginnen.</p>
    </div>`;
  } else {
    let separatorPlaced = false;
    rows.innerHTML = list.map((d) => {
      const [tone, text] = STATUS[d.status] || STATUS.draft;
      const done = d.status === 'completed';
      let sep = '';
      if (done && !separatorPlaced) {
        separatorPlaced = true;
        sep = `<div class="eyebrow" style="margin:24px 0 10px">Abgeschlossen</div>`;
      }
      return sep + `<div class="doc-row${done ? ' done' : ''}" data-id="${d.id}">
        <div style="min-width:0">
          <div style="font-weight:500;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.title)}</div>
          <div class="tiny muted" style="margin-top:2px">
            ${d.signer?.name ? esc(d.signer.name) + ' · ' : ''}${d.pageCount} Seite${d.pageCount === 1 ? '' : 'n'} ·
            ${d.signatureCount} Unterschrift${d.signatureCount === 1 ? '' : 'en'} ·
            ${done ? 'unterschrieben ' + fmtDate(d.completedAt) : 'angelegt ' + fmtDate(d.createdAt)}
          </div>
        </div>
        <span class="pill ${tone}"><span class="dot"></span>${text}</span>
        <div class="row-actions">
          <button class="btn ghost small" data-open="${d.id}">Öffnen</button>
          <button class="btn icon" data-rename="${d.id}" title="Überschrift ändern">${penIcon()}</button>
          ${done
            ? `<button class="btn icon" disabled title="Abgeschlossene Vorgänge sind als Nachweis geschützt und können nicht gelöscht werden" style="opacity:.3;cursor:not-allowed">${lockSmall()}</button>`
            : `<button class="btn icon danger" data-del="${d.id}" title="Vorgang löschen">${trashIcon()}</button>`}
        </div>
      </div>`;
    }).join('');

    rows.querySelectorAll('.doc-row').forEach((r) => r.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions button:not([data-open])')) return;
      openDoc(r.dataset.id);
    }));
    rows.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      openRenameModal(state.docs.find((d) => d.id === b.dataset.rename));
    }));
    rows.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(state.docs.find((d) => d.id === b.dataset.del));
    }));
  }

  document.getElementById('newUpload').addEventListener('click', openUploadModal);
}

function penIcon() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11.2 2.3l2.5 2.5L5.4 13H2.9v-2.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`; }
function trashIcon() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.6 8.2h6.2l.6-8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function lockSmall() { return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M5 7V5.2a3 3 0 016 0V7" stroke="currentColor" stroke-width="1.4"/><rect x="3.6" y="7" width="8.8" height="6.2" rx="1.7" fill="currentColor"/></svg>`; }

/* --------------------------------------------------------- Hochladen --- */

function openUploadModal() {
  let files = [];
  const m = modal(`
    <div class="eyebrow">Neuer Vorgang</div>
    <h2 style="margin:4px 0 6px">PDF hochladen</h2>
    <p class="small muted" style="margin-bottom:20px">Mehrere Dateien werden in der gewählten Reihenfolge zu einem Dokument zusammengeführt.</p>
    <label class="field"><span>Überschrift des Vorgangs</span>
      <input type="text" id="uTitle" placeholder="z. B. Maklervollmacht Familie Bauer" autofocus></label>
    <div class="dropzone" id="dz" tabindex="0" role="button">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="margin-bottom:10px">
        <path d="M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 15v3.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      <div style="font-weight:500;font-size:14.5px">PDF hierher ziehen</div>
      <div class="small muted" style="margin-top:3px">oder klicken, um Dateien zu wählen</div>
    </div>
    <input type="file" id="uFiles" accept="application/pdf" multiple hidden>
    <div id="uList" style="margin-top:14px"></div>
    <div style="display:flex;gap:10px;margin-top:22px;align-items:center">
      <div class="tiny muted" id="uInfo"></div>
      <div style="flex:1"></div>
      <button class="btn" id="uCancel">Abbrechen</button>
      <button class="btn primary" id="uOk" disabled>Hochladen</button>
    </div>`, { wide: true });

  const dz = m.el.querySelector('#dz');
  const input = m.el.querySelector('#uFiles');
  const list = m.el.querySelector('#uList');
  const info = m.el.querySelector('#uInfo');
  const ok = m.el.querySelector('#uOk');

  const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' kB';

  function draw() {
    list.innerHTML = files.map((f, i) => `
      <div class="filerow">
        <span class="filerow-num">${i + 1}</span>
        <div style="min-width:0;flex:1">
          <div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
          <div class="tiny muted">${kb(f.size)}</div>
        </div>
        <button class="btn icon" data-up="${i}" ${i === 0 ? 'disabled style="opacity:.25"' : ''} title="Nach oben">↑</button>
        <button class="btn icon" data-down="${i}" ${i === files.length - 1 ? 'disabled style="opacity:.25"' : ''} title="Nach unten">↓</button>
        <button class="btn icon danger" data-rm="${i}" title="Entfernen">×</button>
      </div>`).join('');
    list.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.up; [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw();
    }));
    list.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.down; [files[i + 1], files[i]] = [files[i], files[i + 1]]; draw();
    }));
    list.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      files.splice(+b.dataset.rm, 1); draw();
    }));
    ok.disabled = files.length === 0;
    info.textContent = files.length
      ? (files.length === 1 ? '1 Datei' : `${files.length} Dateien werden zusammengeführt`)
      : '';
  }

  function add(incoming) {
    const rejected = [];
    for (const f of incoming) {
      if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { rejected.push(f.name); continue; }
      if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
    }
    if (rejected.length) toast(`Nur PDF-Dateien: ${rejected.join(', ')} übersprungen.`, 'err');
    draw();
  }

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });

  let depth = 0;
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragenter') depth++;
    dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave') { depth--; if (depth > 0) return; }
    depth = 0;
    dz.classList.remove('over');
  }));
  dz.addEventListener('drop', (e) => add([...(e.dataTransfer?.files || [])]));
  // Verhindert, dass ein danebengegangener Drop die Datei im Browser öffnet.
  const swallow = (e) => { if (e.target.closest('.backdrop')) e.preventDefault(); };
  document.addEventListener('dragover', swallow);
  document.addEventListener('drop', swallow);

  m.el.querySelector('#uCancel').addEventListener('click', () => {
    document.removeEventListener('dragover', swallow);
    document.removeEventListener('drop', swallow);
    m.close();
  });

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    ok.innerHTML = '<span class="spinner"></span> Wird verarbeitet …';
    const title = m.el.querySelector('#uTitle').value.trim() || files[0].name.replace(/\.pdf$/i, '');
    try {
      // Zusammenführen passiert hier im Browser — der Server bekommt ein fertiges PDF.
      const buffers = [];
      for (const f of files) buffers.push(await f.arrayBuffer());
      const { bytes, pageCount } = await PDFTools.merge(buffers);
      const query = new URLSearchParams({ title, pages: String(pageCount), hash: await PDFTools.hash(bytes) });
      if (files.length > 1) query.set('merged', String(files.length));
      const doc = await api('/api/documents?' + query, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: bytes,
      });
      document.removeEventListener('dragover', swallow);
      document.removeEventListener('drop', swallow);
      m.close();
      await loadAll();
      openDoc(doc.id);
    } catch (err) {
      toast(err.message.includes('encrypt') || err.message.includes('password')
        ? 'Das PDF ist passwortgeschützt und kann nicht verarbeitet werden.'
        : 'Das PDF konnte nicht gelesen werden: ' + err.message, 'err');
      ok.disabled = false;
      ok.textContent = 'Hochladen';
    }
  });

  draw();
}

/* ------------------------------------------ Umbenennen und Löschen --- */

function openRenameModal(doc) {
  if (!doc) return;
  const m = modal(`
    <div class="eyebrow">Vorgang</div>
    <h2 style="margin:4px 0 18px">Überschrift ändern</h2>
    <label class="field"><span>Überschrift</span><input type="text" id="rTitle" value="${esc(doc.title)}" autofocus></label>
    <p class="tiny muted" style="margin:-6px 0 20px">Nur für Ihre Übersicht — der Kunde sieht diese Überschrift über dem Dokument.</p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn" id="rCancel">Abbrechen</button>
      <button class="btn primary" id="rOk">Speichern</button>
    </div>`);
  const input = m.el.querySelector('#rTitle');
  input.focus(); input.select();
  m.el.querySelector('#rCancel').addEventListener('click', m.close);
  const commit = async () => {
    const title = input.value.trim();
    if (!title) return toast('Bitte eine Überschrift eintragen.', 'err');
    try {
      await api('/api/documents/' + doc.id + '/title', { method: 'PUT', body: { title } });
      m.close();
      await loadAll();
      render();
      toast('Überschrift geändert');
    } catch (err) { toast(err.message, 'err'); }
  };
  m.el.querySelector('#rOk').addEventListener('click', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
}

function openDeleteModal(doc) {
  if (!doc) return;
  const m = modal(`
    <div class="eyebrow" style="color:var(--red)">Löschen</div>
    <h2 style="margin:4px 0 12px">„${esc(doc.title)}" löschen?</h2>
    <p class="small muted" style="margin-bottom:24px;line-height:1.6">
      Das Dokument, alle gesetzten Felder und das bisherige Ereignisprotokoll werden entfernt.
      Ein bereits versendeter Signaturlink funktioniert danach nicht mehr. Das lässt sich nicht rückgängig machen.
    </p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn" id="dCancel">Abbrechen</button>
      <button class="btn primary" id="dOk" style="background:var(--red)">Endgültig löschen</button>
    </div>`);
  m.el.querySelector('#dCancel').addEventListener('click', m.close);
  m.el.querySelector('#dOk').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('/api/documents/' + doc.id, { method: 'DELETE' });
      m.close();
      await loadAll();
      render();
      toast('Vorgang gelöscht');
    } catch (err) { toast(err.message, 'err'); m.close(); }
  });
}

async function openDoc(id) {
  try {
    const doc = await api('/api/documents/' + id);
    state.doc = doc;
    state.selected = null;
    state.tool = null;
    state.view = doc.status === 'completed' ? 'detail' : 'editor';
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ------------------------------------------------------------ Editor --- */

function renderEditor(root) {
  const doc = state.doc;
  root.innerHTML = `
    <div class="page-head">
      <div style="min-width:0">
        <button class="btn ghost small" id="back" style="margin-left:-12px;margin-bottom:4px">← Alle Vorgänge</button>
        <h1 id="titleView" style="cursor:text" title="Zum Umbenennen klicken">${esc(doc.title)}</h1>
        <p class="small muted" style="margin-top:4px">Ziehen Sie mit der Maus ein Feld auf das Dokument.</p>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn" id="saveBtn">Speichern</button>
        <button class="btn primary" id="sendBtn">Weiter zum Versand</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 300px;gap:22px;align-items:start">
      <div>
        <div class="card" style="padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;position:sticky;top:14px;z-index:20">
          <span class="tiny muted" style="margin-right:2px">Werkzeug</span>
          ${TOOL_ORDER.map((key) => `
            <button class="btn small tool" data-tool="${key}" style="font-size:13px;padding:7px 13px">${FIELD_TYPES[key].icon} ${FIELD_TYPES[key].label.replace(' (nur für den Kunden)', '')}</button>
          `).join('')}
          <div style="flex:1"></div>
          <div class="segmented" id="zoom">
            <button data-z="0.75">75 %</button><button data-z="1" aria-pressed="true">100 %</button><button data-z="1.4">140 %</button>
          </div>
        </div>
        <div class="stage" id="stage"><div style="display:flex;justify-content:center;padding:60px"><div class="spinner dark"></div></div></div>
      </div>
      <div id="inspector"></div>
    </div>`;

  document.getElementById('back').addEventListener('click', async () => { await loadAll(); state.view = 'list'; render(); });
  document.getElementById('saveBtn').addEventListener('click', () => saveDoc(true));
  document.getElementById('sendBtn').addEventListener('click', async () => { await saveDoc(false); openSendModal(); });
  document.getElementById('titleView').addEventListener('click', renameDoc);

  root.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
    state.tool = state.tool === b.dataset.tool ? null : b.dataset.tool;
    root.querySelectorAll('.tool').forEach((x) => x.classList.toggle('primary', x.dataset.tool === state.tool));
    document.querySelectorAll('.overlay').forEach((o) => o.classList.toggle('drawing', Boolean(state.tool)));
  }));

  document.getElementById('zoom').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#zoom button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    state.zoom = Number(btn.dataset.z);
    renderPages();
  });

  renderInspector();
  renderPages();
}

function renameDoc() {
  const el = document.getElementById('titleView');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.doc.title;
  input.style.cssText = 'font-size:26px;font-weight:600;letter-spacing:-.03em;padding:2px 8px';
  el.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    state.doc.title = input.value.trim() || state.doc.title;
    render();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

async function renderPages() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  const url = `/api/documents/${state.doc.id}/file?inline=1`;
  if (!state.pdfDoc || state.pdfUrl !== url) {
    state.pdfDoc = await pdfjsLib.getDocument(url).promise;
    state.pdfUrl = url;
  }
  stage.innerHTML = '';
  const width = Math.min(880, stage.clientWidth - 52) * state.zoom;

  for (let i = 0; i < state.pdfDoc.numPages; i++) {
    const page = await state.pdfDoc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';
    wrap.dataset.page = String(i);
    wrap.innerHTML = `<span class="page-num">Seite ${i + 1}</span>`;

    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);
    page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });

    const overlay = document.createElement('div');
    overlay.className = 'overlay' + (state.tool ? ' drawing' : '');
    overlay.dataset.page = String(i);
    wrap.appendChild(overlay);
    stage.appendChild(wrap);

    attachDrawing(overlay, i);
  }
  paintFields();
}

function attachDrawing(overlay, pageIndex) {
  overlay.addEventListener('mousedown', (e) => {
    if (!state.tool || e.target !== overlay) return;
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    const box = document.createElement('div');
    box.className = 'marquee';
    overlay.appendChild(box);

    const move = (ev) => {
      const x1 = Math.min(Math.max(ev.clientX - rect.left, 0), rect.width);
      const y1 = Math.min(Math.max(ev.clientY - rect.top, 0), rect.height);
      box.style.left = Math.min(x0, x1) + 'px';
      box.style.top = Math.min(y0, y1) + 'px';
      box.style.width = Math.abs(x1 - x0) + 'px';
      box.style.height = Math.abs(y1 - y0) + 'px';
    };
    const up = (ev) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      const x1 = Math.min(Math.max(ev.clientX - rect.left, 0), rect.width);
      const y1 = Math.min(Math.max(ev.clientY - rect.top, 0), rect.height);
      box.remove();
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      if (w < 24 || h < 14) return; // versehentlicher Klick
      const type = state.tool;
      const field = {
        id: 'f' + Math.random().toString(36).slice(2, 10),
        page: pageIndex,
        type,
        label: defaultLabel(type),
        x: Math.min(x0, x1) / rect.width,
        y: Math.min(y0, y1) / rect.height,
        w: w / rect.width,
        h: h / rect.height,
        filledBy: 'customer',
        value: '',
        required: true,
      };
      state.doc.fields.push(field);
      state.selected = field.id;
      paintFields();
      renderInspector();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function defaultLabel(type) {
  return { signature: 'Unterschrift', text: 'Text', place: 'Ort', date: 'Datum', place_date: 'Ort, Datum', note: 'Bitte prüfen Sie diesen Abschnitt.' }[type] || 'Feld';
}

function paintFields() {
  document.querySelectorAll('.overlay').forEach((o) => { o.querySelectorAll('.fld').forEach((f) => f.remove()); });
  for (const field of state.doc.fields || []) {
    const overlay = document.querySelector(`.overlay[data-page="${field.page}"]`);
    if (!overlay) continue;
    const el = document.createElement('div');
    el.className = 'fld' + (field.type === 'note' ? ' note' : '') + (field.filledBy === 'admin' ? ' admin-filled' : '') + (state.selected === field.id ? ' selected' : '');
    el.style.left = field.x * 100 + '%';
    el.style.top = field.y * 100 + '%';
    el.style.width = field.w * 100 + '%';
    el.style.height = field.h * 100 + '%';
    el.dataset.id = field.id;
    const shown = field.filledBy === 'admin' && field.value ? field.value : field.label;
    el.innerHTML = `<span style="padding:0 4px;text-align:center;line-height:1.2">${esc(shown)}</span>
      <span class="kill" title="Feld entfernen">×</span><span class="handle"></span>`;
    overlay.appendChild(el);

    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('kill')) return;
      e.stopPropagation();
      state.selected = field.id;
      paintFields();
      renderInspector();
      const resizing = e.target.classList.contains('handle');
      const rect = overlay.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, fx: field.x, fy: field.y, fw: field.w, fh: field.h };
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / rect.width;
        const dy = (ev.clientY - start.y) / rect.height;
        if (resizing) {
          field.w = Math.max(0.03, Math.min(1 - field.x, start.fw + dx));
          field.h = Math.max(0.012, Math.min(1 - field.y, start.fh + dy));
        } else {
          field.x = Math.max(0, Math.min(1 - field.w, start.fx + dx));
          field.y = Math.max(0, Math.min(1 - field.h, start.fy + dy));
        }
        el.style.left = field.x * 100 + '%';
        el.style.top = field.y * 100 + '%';
        el.style.width = field.w * 100 + '%';
        el.style.height = field.h * 100 + '%';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    el.querySelector('.kill').addEventListener('click', (e) => {
      e.stopPropagation();
      state.doc.fields = state.doc.fields.filter((f) => f.id !== field.id);
      if (state.selected === field.id) state.selected = null;
      paintFields();
      renderInspector();
    });
  }
}

function renderInspector() {
  const root = document.getElementById('inspector');
  if (!root) return;
  const field = (state.doc.fields || []).find((f) => f.id === state.selected);
  const counts = (state.doc.fields || []).reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {});

  if (!field) {
    root.innerHTML = `<div class="card" style="position:sticky;top:14px">
      <div class="eyebrow" style="margin-bottom:10px">Felder</div>
      ${Object.keys(counts).length
        ? Object.entries(counts).map(([t, n]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
            <span class="small">${FIELD_TYPES[t]?.label.replace(' (nur für den Kunden)', '') || t}</span><span class="small muted">${n}</span></div>`).join('')
        : '<p class="small muted">Wählen Sie oben ein Werkzeug und ziehen Sie damit ein Feld auf das Dokument.</p>'}
    </div>`;
    return;
  }

  const isNote = field.type === 'note';
  root.innerHTML = `<div class="card" style="position:sticky;top:14px">
    <div class="eyebrow" style="margin-bottom:12px">${FIELD_TYPES[field.type]?.label || field.type} · Seite ${field.page + 1}</div>
    <label class="field"><span>${isNote ? 'Hinweistext für den Kunden' : 'Beschriftung'}</span>
      ${isNote ? `<textarea id="fLabel" rows="3">${esc(field.label)}</textarea>` : `<input type="text" id="fLabel" value="${esc(field.label)}">`}
    </label>
    ${isNote ? '<p class="tiny muted" style="margin-top:-6px;margin-bottom:14px">Dieser Hinweis erscheint nur auf der Signaturseite, nie im PDF.</p>' : ''}
    ${!isNote && field.type !== 'signature' ? `
      <label class="field"><span>Ausfüllen durch</span>
        <select id="fBy">
          <option value="customer" ${field.filledBy === 'customer' ? 'selected' : ''}>Der Kunde trägt es ein</option>
          <option value="admin" ${field.filledBy === 'admin' ? 'selected' : ''}>Ich trage es jetzt ein</option>
        </select></label>
      ${field.filledBy === 'admin' ? `<label class="field"><span>Inhalt</span>
        <input type="text" id="fValue" value="${esc(field.value)}" placeholder="${field.type === 'date' ? 'z. B. 26.08.2026' : field.type === 'place' ? 'z. B. München' : 'Inhalt'}"></label>
        ${field.type !== 'text' ? `<button class="btn small" id="fillToday" style="margin-bottom:14px">${field.type === 'date' ? 'Heutiges Datum einsetzen' : 'Ort und Datum einsetzen'}</button>` : ''}` : ''}
    ` : ''}
    ${!isNote ? `<label class="switch" style="margin-bottom:16px"><input type="checkbox" id="fReq" ${field.required !== false ? 'checked' : ''}><span class="track"></span> Pflichtfeld</label>` : ''}
    <button class="btn danger block small" id="fDel">Feld entfernen</button>
  </div>`;

  const label = document.getElementById('fLabel');
  label.addEventListener('input', () => { field.label = label.value; paintFields(); });
  const by = document.getElementById('fBy');
  if (by) by.addEventListener('change', () => { field.filledBy = by.value; paintFields(); renderInspector(); });
  const value = document.getElementById('fValue');
  if (value) value.addEventListener('input', () => { field.value = value.value; paintFields(); });
  const today = document.getElementById('fillToday');
  if (today) today.addEventListener('click', () => {
    const d = new Date().toLocaleDateString('de-DE');
    field.value = field.type === 'date' ? d : (field.value ? field.value.split(',')[0] + ', ' + d : d);
    paintFields();
    renderInspector();
  });
  const req = document.getElementById('fReq');
  if (req) req.addEventListener('change', () => { field.required = req.checked; });
  document.getElementById('fDel').addEventListener('click', () => {
    state.doc.fields = state.doc.fields.filter((f) => f.id !== field.id);
    state.selected = null;
    paintFields();
    renderInspector();
  });
}

async function saveDoc(notify = true) {
  try {
    const saved = await api('/api/documents/' + state.doc.id, {
      method: 'PUT',
      body: { title: state.doc.title, fields: state.doc.fields, signer: state.doc.signer, language: state.doc.language },
    });
    state.doc = saved;
    if (notify) toast('Gespeichert');
  } catch (err) { toast(err.message, 'err'); }
}

/* ------------------------------------------------------------ Versand --- */

function openSendModal() {
  const doc = state.doc;
  const s = doc.signer || {};
  const m = modal(`
    <div class="eyebrow">Schritt 2</div>
    <h2 style="margin:4px 0 20px">An den Kunden übergeben</h2>
    <div style="display:grid;grid-template-columns:110px 1fr;gap:10px">
      <label class="field"><span>Anrede</span>
        <select id="sSal">
          <option value="herr" ${s.salutation === 'herr' ? 'selected' : ''}>Herr</option>
          <option value="frau" ${s.salutation === 'frau' ? 'selected' : ''}>Frau</option>
          <option value="neutral" ${s.salutation === 'neutral' ? 'selected' : ''}>Neutral</option>
        </select></label>
      <label class="field"><span>Name des Kunden</span><input type="text" id="sName" value="${esc(s.name)}" placeholder="Max Mustermann"></label>
    </div>
    <label class="field"><span>E-Mail-Adresse</span><input type="email" id="sMail" value="${esc(s.email)}" placeholder="kunde@example.com"></label>
    <label class="field"><span>Sprache der Signaturseite</span></label>
    <div class="segmented" id="lang" style="margin:-8px 0 20px">
      <button data-l="de" aria-pressed="${(doc.language || 'de') === 'de'}">Deutsch</button>
      <button data-l="hu" aria-pressed="${doc.language === 'hu'}">Ungarisch · Magyar</button>
    </div>
    <p class="tiny muted" style="margin:-10px 0 20px">Das PDF selbst bleibt immer in seiner Originalsprache.</p>
    <hr class="sep">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="doLink">Link erzeugen und kopieren</button>
      <button class="btn ghost" id="doPreview">E-Mail-Vorschau</button>
      <div style="flex:1"></div>
      <button class="btn primary" id="doSend">E-Mail senden</button>
    </div>
    <div id="linkOut" style="margin-top:16px"></div>
  `, { wide: true });

  const read = () => ({
    signer: {
      salutation: m.el.querySelector('#sSal').value,
      name: m.el.querySelector('#sName').value.trim(),
      email: m.el.querySelector('#sMail').value.trim(),
    },
    language: m.el.querySelector('#lang button[aria-pressed="true"]').dataset.l,
  });

  m.el.querySelector('#lang').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    m.el.querySelectorAll('#lang button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });

  m.el.querySelector('#doLink').addEventListener('click', async () => {
    const payload = read();
    try {
      state.doc.signer = payload.signer;
      state.doc.language = payload.language;
      await saveDoc(false);
      const res = await api(`/api/documents/${doc.id}/link`, { method: 'POST', body: { language: payload.language } });
      const out = m.el.querySelector('#linkOut');
      out.innerHTML = `<div style="background:var(--surface-2);border-radius:var(--radius);padding:14px">
        <div class="eyebrow" style="margin-bottom:6px">Signaturlink</div>
        <div class="mono" style="word-break:break-all;color:var(--accent)">${esc(res.url)}</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn small" id="copyLink">Kopieren</button>
          <a class="btn small" href="${res.url}" target="_blank" rel="noopener">Öffnen</a>
        </div></div>`;
      out.querySelector('#copyLink').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(res.url); toast('Link kopiert'); }
        catch { toast('Bitte den Link manuell markieren und kopieren.', 'err'); }
      });
      await navigator.clipboard.writeText(res.url).then(() => toast('Link kopiert')).catch(() => {});
      await loadAll();
    } catch (err) { toast(err.message, 'err'); }
  });

  m.el.querySelector('#doPreview').addEventListener('click', async () => {
    try {
      const mail = await api(`/api/documents/${doc.id}/preview-mail`, { method: 'POST', body: read() });
      modal(`<div class="eyebrow">Vorschau</div>
        <h3 style="margin:4px 0 14px">${esc(mail.subject)}</h3>
        <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
          <iframe style="width:100%;height:380px;border:0" srcdoc="${esc(mail.html)}"></iframe>
        </div>`, { wide: true });
    } catch (err) { toast(err.message, 'err'); }
  });

  m.el.querySelector('#doSend').addEventListener('click', async (e) => {
    const payload = read();
    if (!payload.signer.email) return toast('Bitte eine E-Mail-Adresse eintragen.', 'err');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Senden …';
    try {
      state.doc.signer = payload.signer;
      state.doc.language = payload.language;
      await saveDoc(false);
      const res = await api(`/api/documents/${doc.id}/send`, { method: 'POST', body: payload });
      m.close();
      await loadAll();
      state.view = 'list';
      render();
      toast(res.simulated ? 'Kein SMTP konfiguriert — E-Mail wurde nur protokolliert.' : 'E-Mail versendet', res.simulated ? 'err' : 'ok');
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'E-Mail senden';
    }
  });
}

/* -------------------------------------------------------- Abschluss --- */

function renderDetail(root) {
  const doc = state.doc;
  const sigs = (doc.fields || []).filter((f) => f.type === 'signature');
  const signedEvents = (doc.events || []).filter((e) => e.type === 'field_signed');
  const days = state.retentionDays;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn ghost small" id="back" style="margin-left:-12px;margin-bottom:4px">← Alle Vorgänge</button>
        <div class="eyebrow">Abgeschlossen am ${fmtDate(doc.completedAt)}</div>
        <h1>${esc(doc.title)}</h1>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px;background:linear-gradient(120deg,rgba(0,113,227,.06),rgba(0,113,227,.02));">
      <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          <h3 style="margin-bottom:6px">Jetzt sichern</h3>
          <p class="small muted" style="line-height:1.6;margin-bottom:16px">
            Laden Sie beide Dateien herunter und legen Sie sie in Ihrer Kundenakte ab.
            Danach können Sie den Vorgang hier löschen — spätestens ${days} Tage nach Abschluss
            wird er ohnehin automatisch entfernt.
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" id="dlSigned">Unterschriebenes PDF</button>
            <button class="btn" id="dlProtocol">Protokoll (PDF)</button>
            <button class="btn" id="dlBoth">Beides auf einmal</button>
          </div>
        </div>
        <div style="min-width:180px">
          <div class="eyebrow" style="margin-bottom:8px">Heruntergeladen</div>
          <div class="small" id="dlState" style="line-height:1.9">
            <div><span class="tickbox" data-t="signed">○</span> Dokument</div>
            <div><span class="tickbox" data-t="protocol">○</span> Protokoll</div>
          </div>
          <button class="btn danger small block" id="finish" style="margin-top:14px" disabled>Vorgang löschen</button>
        </div>
      </div>
    </div>

    <div class="split" style="display:grid;grid-template-columns:1fr 340px;gap:22px;align-items:start">
      <div class="card">
        <h3 style="margin-bottom:14px">Unterschriften</h3>
        ${sigs.map((f) => {
          const ev = signedEvents.find((e) => e.fieldId === f.id);
          return `<div style="display:flex;gap:16px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)">
            <div style="width:170px;height:58px;background:var(--surface-2);border-radius:var(--radius-s);display:grid;place-items:center;flex:none">
              ${ev?.value ? `<img src="${ev.value}" alt="Unterschrift" style="max-width:150px;max-height:48px">` : '<span class="tiny muted">—</span>'}
            </div>
            <div style="min-width:0">
              <div style="font-weight:500">${esc(f.label || 'Unterschrift')}</div>
              <div class="tiny muted">Seite ${f.page + 1} · ${ev ? fmtDate(ev.at) : 'offen'}</div>
              <div class="tiny muted">${ev?.method === 'typed' ? 'Getippt' : 'Freihändig gezeichnet'}${ev?.ip ? ' · IP ' + esc(ev.ip) : ''}</div>
            </div>
          </div>`;
        }).join('') || '<p class="small muted">Keine Unterschriftsfelder.</p>'}

        ${signedEvents.filter((e) => e.textValue).length ? `
          <h3 style="margin:26px 0 14px">Weitere Eingaben</h3>
          ${signedEvents.filter((e) => e.textValue).map((e) => `
            <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">
              <span class="small muted">${esc(e.detail || '')}</span><span class="small">${esc(e.textValue)}</span>
            </div>`).join('')}` : ''}
      </div>

      <div class="card">
        <h3 style="margin-bottom:6px">Nachweis</h3>
        <p class="tiny muted" style="margin-bottom:16px">Zeitstempel, Herkunft und Prüfsummen — vollständig im Protokoll-PDF.</p>
        <div class="timeline">
          ${(doc.events || []).map((e) => `<div class="timeline-item">
            <div class="small" style="font-weight:500">${esc(eventLabel(e.type))}</div>
            <div class="tiny muted">${fmtDate(e.at)}</div>
            ${e.detail ? `<div class="tiny muted">${esc(e.detail)}</div>` : ''}
            ${e.ip ? `<div class="tiny muted">IP ${esc(e.ip)}${originOf(e) ? ' · ' + esc(originOf(e)) : ''}</div>` : ''}
          </div>`).join('')}
        </div>
        <hr class="sep">
        <div class="eyebrow" style="margin-bottom:6px">Prüfsumme signiert</div>
        <div class="mono muted" style="word-break:break-all">${esc(doc.hashSigned || '—')}</div>
      </div>
    </div>`;

  document.getElementById('back').addEventListener('click', async () => { await loadAll(); state.view = 'list'; render(); });

  const got = { signed: false, protocol: false };
  const refresh = () => {
    root.querySelectorAll('.tickbox').forEach((el) => {
      const done = got[el.dataset.t];
      el.textContent = done ? '●' : '○';
      el.style.color = done ? 'var(--green)' : 'var(--muted)';
    });
    document.getElementById('finish').disabled = !(got.signed && got.protocol);
  };

  const safe = (suffix) => (doc.title || 'Dokument').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60) + suffix;

  async function grabSigned() {
    const res = await fetch(`/api/documents/${doc.id}/file?signed=1`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Das Dokument ist nicht mehr verfügbar.');
    PDFTools.download(await res.arrayBuffer(), safe(' (unterschrieben).pdf'));
    got.signed = true;
    refresh();
  }

  async function grabProtocol() {
    // Wird hier im Browser erzeugt — der Worker hätte dafür zu wenig Rechenzeit.
    PDFTools.download(await PDFTools.protocol(doc), safe(' – Protokoll.pdf'));
    got.protocol = true;
    refresh();
  }

  const guard = (fn, button, label) => async () => {
    button.disabled = true;
    button.innerHTML = '<span class="spinner dark"></span> Moment …';
    try { await fn(); } catch (err) { toast(err.message, 'err'); }
    button.disabled = false;
    button.textContent = label;
  };

  const b1 = document.getElementById('dlSigned');
  const b2 = document.getElementById('dlProtocol');
  const b3 = document.getElementById('dlBoth');
  b1.addEventListener('click', guard(grabSigned, b1, 'Unterschriebenes PDF'));
  b2.addEventListener('click', guard(grabProtocol, b2, 'Protokoll (PDF)'));
  b3.addEventListener('click', guard(async () => { await grabSigned(); await grabProtocol(); }, b3, 'Beides auf einmal'));

  document.getElementById('finish').addEventListener('click', () => {
    const m = modal(`
      <div class="eyebrow" style="color:var(--red)">Löschen</div>
      <h2 style="margin:4px 0 12px">Vorgang endgültig entfernen?</h2>
      <p class="small muted" style="margin-bottom:12px;line-height:1.6">
        Das unterschriebene Dokument und das Protokoll werden vom Server gelöscht.
        Beides lässt sich danach nicht wiederherstellen.
      </p>
      <p class="small" style="margin-bottom:24px;line-height:1.6">
        Bitte vergewissern Sie sich, dass beide Dateien auf Ihrer Festplatte liegen und sich öffnen lassen.
      </p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" id="cx">Abbrechen</button>
        <button class="btn primary" id="ok" style="background:var(--red)">Ja, gesichert und löschen</button>
      </div>`);
    m.el.querySelector('#cx').addEventListener('click', m.close);
    m.el.querySelector('#ok').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/documents/${doc.id}?confirmed=1`, { method: 'DELETE' });
        m.close();
        await loadAll();
        state.view = 'list';
        render();
        toast('Vorgang gelöscht — die Dateien liegen jetzt nur noch bei Ihnen.');
      } catch (err) { toast(err.message, 'err'); m.close(); }
    });
  });

  refresh();
}

function originOf(ev) {
  const place = [ev.city, ev.region, ev.country].filter(Boolean).join(', ');
  return [place, ev.network].filter(Boolean).join(' · ');
}

function eventLabel(type) {
  return {
    created: 'Dokument angelegt', fields_saved: 'Felder gespeichert', link_created: 'Signaturlink erzeugt',
    email_sent: 'E-Mail versendet', opened: 'Vom Kunden geöffnet', field_signed: 'Feld unterschrieben',
    completed: 'Vorgang abgeschlossen', downloaded: 'Dokument heruntergeladen', notification_sent: 'Benachrichtigung versendet',
  }[type] || type;
}

/* --------------------------------------------------------------- Start --- */

async function loadAll() {
  state.docs = await api('/api/documents');
}

(async function init() {
  const session = await api('/api/session');
  state.authed = session.authenticated;
  state.smtp = Boolean(session.mail);
  state.email = session.email;
  state.notifyEmail = session.notifyEmail;
  state.retentionDays = session.retentionDays || 14;
  if (state.authed) await loadAll();
  render();
})();
