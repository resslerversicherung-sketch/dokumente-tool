/**
 * RESSLER-DOKUMENTE — Cloudflare Worker
 *
 * Die Anwendung speichert bewusst nur so lange, wie ein Vorgang läuft.
 * Alles Rechenintensive (PDF zusammenführen, Unterschrift einstempeln,
 * Protokoll erzeugen) passiert im Browser — der Worker reicht nur Bytes
 * durch und bleibt damit weit unter dem CPU-Limit des Gratis-Tarifs.
 *
 * Ablage in R2:
 *   index.json          Kurzübersicht aller Vorgänge
 *   d/<id>/meta.json    Felder, Unterzeichner, Ereignisprotokoll
 *   d/<id>/original.pdf Hochgeladenes Dokument
 *   d/<id>/signed.pdf   Unterschriebene Fassung
 *   t/<token>           Verweis vom Signaturlink auf die Vorgangs-ID
 */

const COOKIE = 'rd_session';
const SESSION_HOURS = 12;
const DEFAULT_RETENTION_DAYS = 14;

/* ------------------------------------------------------------ Helfer --- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

const bad = (message, status = 400) => json({ error: message }, status);

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

function makeId(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Zeitkonstanter Vergleich — verrät nichts über Antwortzeiten. */
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/* -------------------------------------------------------- Sitzungen --- */
/* Workers haben keinen gemeinsamen Arbeitsspeicher. Die Sitzung steckt
   deshalb signiert im Cookie selbst und braucht keine Ablage.            */

async function signingKey(env) {
  const secret = env.SESSION_SECRET || (env.ADMIN_PASSWORD + '|' + env.ADMIN_EMAIL);
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function createSession(env, email) {
  const payload = b64url(enc.encode(JSON.stringify({ email, exp: Date.now() + SESSION_HOURS * 3600e3 })));
  const key = await signingKey(env);
  const mac = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  return `${payload}.${mac}`;
}

async function readSession(env, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  try {
    const key = await signingKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, unb64url(mac), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(unb64url(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/* ------------------------------------------------------------- R2 ------ */

async function readJson(env, key) {
  const object = await env.DOCS.get(key);
  if (!object) return null;
  return object.json();
}

const writeJson = (env, key, value) =>
  env.DOCS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

const loadIndex = async (env) => (await readJson(env, 'index.json')) || [];
const saveIndex = (env, list) => writeJson(env, 'index.json', list);

function summarize(doc) {
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt || null,
    sentAt: doc.sentAt || null,
    language: doc.language,
    signer: doc.signer,
    token: doc.token || null,
    pageCount: doc.pageCount,
    signatureCount: (doc.fields || []).filter((f) => f.type === 'signature').length,
  };
}

async function updateIndex(env, doc) {
  const list = await loadIndex(env);
  const entry = summarize(doc);
  const at = list.findIndex((d) => d.id === doc.id);
  if (at === -1) list.unshift(entry);
  else list[at] = entry;
  await saveIndex(env, list);
}

async function removeDocument(env, id, token) {
  const keys = [`d/${id}/meta.json`, `d/${id}/original.pdf`, `d/${id}/signed.pdf`, `d/${id}/translation-hu.json`];
  if (token) keys.push(`t/${token}`);
  await Promise.all(keys.map((k) => env.DOCS.delete(k)));
  const list = (await loadIndex(env)).filter((d) => d.id !== id);
  await saveIndex(env, list);
}

/* ---------------------------------------------------------- Protokoll -- */

/** Herkunftsdaten aus Cloudflares Netz — genauer als eine reine IP-Notiz. */
function auditContext(request, extra = {}) {
  const cf = request.cf || {};
  return {
    at: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || '',
    country: cf.country || '',
    region: cf.region || '',
    city: cf.city || '',
    network: cf.asOrganization || '',
    timezone: cf.timezone || '',
    ua: request.headers.get('User-Agent') || '',
    ...extra,
  };
}

/* ------------------------------------------------------------ E-Mail --- */

function salutation(signer, lang) {
  const name = (signer?.name || '').trim();
  if (lang === 'hu') return name ? `Tisztelt ${name}!` : 'Tisztelt Ügyfelünk!';
  if (signer?.salutation === 'herr') return `Sehr geehrter Herr ${name},`;
  if (signer?.salutation === 'frau') return `Sehr geehrte Frau ${name},`;
  return `Sehr geehrte(r) Frau / Herr ${name},`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function signRequestMail(doc, link) {
  const lang = doc.language === 'hu' ? 'hu' : 'de';
  const hello = salutation(doc.signer, lang);
  const body = lang === 'hu'
    ? 'mellékelten megküldjük Önnek biztosítási közvetítőjétől a digitális aláírásra váró dokumentumokat.'
    : 'anbei übersenden wir Ihnen die Dokumente zur Digitalen Unterschrift von ihrem Versicherungsvermittler.';
  const cta = lang === 'hu' ? 'Dokumentumok aláírása' : 'Dokumente jetzt unterschreiben';
  const bye = lang === 'hu' ? 'Üdvözlettel<br>Az Ön biztosítási közvetítője' : 'Mit freundlichen Grüßen<br>Ihr Versicherungsvermittler';
  const subject = lang === 'hu'
    ? `Dokumentumok digitális aláírásra: ${doc.title}`
    : `Dokumente zur digitalen Unterschrift: ${doc.title}`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;padding:36px 32px">
    <p style="margin:0 0 18px;font-size:16px">${escapeHtml(hello)}</p>
    <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#3a3a3c">${escapeHtml(body)}</p>
    <a href="${link}" style="display:inline-block;background:#0071e3;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:13px 26px;border-radius:980px">${cta}</a>
    <p style="margin:26px 0 0;font-size:12px;line-height:1.6;color:#86868b">${
      lang === 'hu' ? 'Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe:' : 'Falls der Button nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:'
    }<br><span style="color:#0071e3;word-break:break-all">${escapeHtml(link)}</span></p>
    <p style="margin:26px 0 0;font-size:14px;color:#3a3a3c">${bye}</p>
  </div></body></html>`;

  return { subject, html, text: `${hello}\n\n${body}\n\n${link}` };
}

/**
 * Versand über eine HTTP-Schnittstelle.
 *
 * Cloudflare Workers können kein SMTP — das ist eine Eigenschaft der Plattform.
 * Unterstützt werden Resend und Brevo; welcher Dienst genutzt wird, ergibt sich
 * daraus, welcher Schlüssel hinterlegt ist. Resend hat Vorrang.
 */
/**
 * Kann an beliebige Empfänger versendet werden?
 *
 * Ohne bestätigte eigene Domain lässt Resend nur den Testabsender
 * onboarding@resend.dev zu — und der darf ausschließlich an die Adresse
 * schreiben, mit der das Resend-Konto angelegt wurde. Für die
 * Benachrichtigung an den Vermittler reicht das; für Kundenmails nicht.
 */
function canMailAnyone(env) {
  if (!env.RESEND_API_KEY && !env.BREVO_API_KEY) return false;
  const from = String(env.MAIL_FROM || '').trim().toLowerCase();
  if (!from) return false;
  return !from.endsWith('@resend.dev');
}

/** ArrayBuffer -> Base64, in Blöcken, damit der Aufrufstapel nicht überläuft. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sendMail(env, { to, toName, subject, html, text, attachments }) {
  const senderName = env.MAIL_FROM_NAME || 'Ressler Versicherung';
  const senderEmail = env.MAIL_FROM || 'onboarding@resend.dev';

  if (env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${senderName} <${senderEmail}>`,
        to: [to],
        subject,
        html,
        text,
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.base64 })) }
          : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend meldet ${response.status}: ${detail.slice(0, 300)}`);
    }
    return { ok: true, via: 'resend' };
  }

  if (env.BREVO_API_KEY) {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
        textContent: text,
        ...(attachments?.length
          ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.base64 })) }
          : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Brevo meldet ${response.status}: ${detail.slice(0, 300)}`);
    }
    return { ok: true, via: 'brevo' };
  }

  return {
    ok: false,
    simulated: true,
    reason: 'Kein Versanddienst hinterlegt — die E-Mail wurde nur protokolliert.',
  };
}


/* ------------------------------------------------------- Übersetzung --- */
/* Workers AI läuft im Netz von Cloudflare. Der Aufruf ist Wartezeit, keine
   Rechenzeit des Workers — die 10-ms-Grenze des Gratis-Tarifs greift nicht.
   Frei sind 10.000 „Neurons" pro Tag, das reicht für rund 250 Seiten.     */

const DEFAULT_TRANSLATION_MODEL = '@cf/zai-org/glm-4.7-flash';

const TRANSLATION_PROMPT =
  'Du bist ein professioneller Übersetzer für Versicherungs- und Vertragsunterlagen. '
  + 'Übersetze den folgenden deutschen Text ins Ungarische. '
  + 'Behalte Zeilenumbrüche, Aufzählungen und Nummerierungen bei. '
  + 'Namen, Beträge, Daten, Vertrags- und Versicherungsnummern, Adressen und Kennzeichen '
  + 'übernimmst du unverändert. Fachbegriffe gibst du mit dem in Ungarn üblichen '
  + 'Versicherungsbegriff wieder. Antworte ausschließlich mit der ungarischen Übersetzung, '
  + 'ohne Einleitung, ohne Kommentar, ohne Anführungszeichen.';

function splitForTranslation(text, max = 1600) {
  const parts = [];
  let current = '';
  const push = () => { if (current.trim()) parts.push(current); current = ''; };
  for (const paragraph of String(text).split(/\n{2,}/)) {
    if (paragraph.length > max) {
      push();
      for (const line of paragraph.split('\n')) {
        if ((current + '\n' + line).length > max && current) push();
        current = current ? current + '\n' + line : line;
      }
      continue;
    }
    if ((current + '\n\n' + paragraph).length > max && current) push();
    current = current ? current + '\n\n' + paragraph : paragraph;
  }
  push();
  return parts;
}

function readAiText(result) {
  let text = '';
  if (!result) text = '';
  else if (typeof result === 'string') text = result;
  else if (typeof result.response === 'string') text = result.response;
  else if (result.choices?.[0]?.message?.content) text = String(result.choices[0].message.content);
  else if (typeof result.choices?.[0]?.text === 'string') text = result.choices[0].text;
  else if (typeof result.result?.response === 'string') text = result.result.response;
  // Manche Modelle denken sichtbar vor sich hin — das gehört nicht in die Übersetzung.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```[a-z]*\n?|```$/g, '').trim();
}

/** Bricht ab, statt endlos zu warten. Ohne das hängt die Oberfläche. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

/** Ein Stück übersetzen — mit Zeitgrenze und einem Versuch bei Auslastung. */
async function translateChunk(env, model, chunk) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withTimeout(
        env.AI.run(model, {
          messages: [
            { role: 'system', content: TRANSLATION_PROMPT },
            { role: 'user', content: chunk },
          ],
          max_tokens: 1800,
          temperature: 0.2,
        }),
        45000,
        'Das Modell hat nach 45 Sekunden nicht geantwortet.'
      );
      const text = readAiText(result);
      if (!text) throw new Error('Das Modell hat nichts zurückgegeben.');
      return text;
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      if (!/3040|capacity|429|nicht geantwortet/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError;
}

/** Die Stücke einer Seite laufen gleichzeitig — das ist der Zeitgewinn. */
async function translateText(env, text) {
  const model = env.TRANSLATION_MODEL || DEFAULT_TRANSLATION_MODEL;
  const chunks = splitForTranslation(text);
  const done = await Promise.all(chunks.map((c) => translateChunk(env, model, c)));
  return done.join('\n\n');
}

function aiErrorMessage(err) {
  const msg = String(err?.message || err);
  if (msg.includes('3036') || /daily free allocation/i.test(msg)) {
    return 'Das tägliche Gratis-Kontingent der Übersetzung ist aufgebraucht. Es setzt sich um 02:00 Uhr deutscher Zeit zurück.';
  }
  if (msg.includes('3040') || /capacity/i.test(msg)) {
    return 'Die Übersetzung ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.';
  }
  if (msg.includes('5035') || /Workers Paid plan/i.test(msg)) {
    return 'Dieses KI-Modell ist im Gratis-Tarif nicht verfügbar. Tragen Sie in wrangler.jsonc bei TRANSLATION_MODEL ein anderes Modell ein.';
  }
  if (/No such model|not found|invalid model/i.test(msg)) {
    return 'Das eingetragene KI-Modell gibt es nicht. Bitte TRANSLATION_MODEL in wrangler.jsonc prüfen.';
  }
  if (/nicht geantwortet|nichts zurückgegeben/i.test(msg)) {
    return msg + ' Versuchen Sie ein anderes Modell über TRANSLATION_MODEL in wrangler.jsonc.';
  }
  return 'Übersetzung fehlgeschlagen: ' + msg.slice(0, 200);
}

/* -------------------------------------------------------- Anmeldung --- */
/* Ohne Durable Objects gibt es keinen geteilten Zähler. Diese Bremse wirkt
   pro Worker-Instanz — sie hilft, ersetzt aber kein starkes Passwort.     */
const recentFailures = new Map();

function tooManyAttempts(ip) {
  const entry = recentFailures.get(ip);
  if (!entry || Date.now() > entry.until) return 0;
  return entry.count >= 8 ? Math.ceil((entry.until - Date.now()) / 60000) : 0;
}

function noteFailure(ip) {
  const entry = recentFailures.get(ip);
  if (entry && Date.now() <= entry.until) entry.count++;
  else recentFailures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
}

async function serveAsset(env, url, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, url)));
  // Neu zusammensetzen, damit Header wie Content-Type sicher gesetzt sind.
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/* ------------------------------------------------------------ Router --- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
      return new Response(
        'Zugangsdaten fehlen. Bitte ADMIN_EMAIL und ADMIN_PASSWORD als Secrets im Cloudflare-Dashboard hinterlegen.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    // Die beiden Einstiegsseiten werden ausdrücklich zugeordnet, damit das
    // Asset-System keine Adressen umschreibt und keine Umleitung entsteht.
    if (pathname === '/' || pathname === '/index.html') {
      return serveAsset(env, url, '/index.html');
    }
    if (pathname === '/sign' || pathname.startsWith('/sign/')) {
      return serveAsset(env, url, '/sign.html');
    }
    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      return bad('Unerwarteter Fehler: ' + (err?.message || err), 500);
    }
  },

  /** Nächtlicher Aufräumlauf: alles löschen, was die Aufbewahrungsfrist überschreitet. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};

async function cleanup(env) {
  const days = Number(env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  if (!days) return;
  const cutoff = Date.now() - days * 86400e3;
  const list = await loadIndex(env);
  const keep = [];
  for (const entry of list) {
    const reference = entry.completedAt || entry.createdAt;
    if (new Date(reference).getTime() < cutoff) {
      await Promise.all([
        env.DOCS.delete(`d/${entry.id}/meta.json`),
        env.DOCS.delete(`d/${entry.id}/original.pdf`),
        env.DOCS.delete(`d/${entry.id}/signed.pdf`),
        env.DOCS.delete(`d/${entry.id}/translation-hu.json`),
        entry.token ? env.DOCS.delete(`t/${entry.token}`) : Promise.resolve(),
      ]);
    } else {
      keep.push(entry);
    }
  }
  if (keep.length !== list.length) await saveIndex(env, keep);
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname.slice(5); // ohne "/api/"
  const method = request.method;
  const segments = path.split('/').filter(Boolean);

  /* --- offene Endpunkte --------------------------------------------- */

  if (path === 'login' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unbekannt';
    const blocked = tooManyAttempts(ip);
    if (blocked) return bad(`Zu viele Fehlversuche. Bitte in ${blocked} Minute(n) erneut versuchen.`, 429);

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const [emailOk, passwordOk] = await Promise.all([
      sameSecret(email, String(env.ADMIN_EMAIL).trim().toLowerCase()),
      sameSecret(password, env.ADMIN_PASSWORD),
    ]);
    if (!emailOk || !passwordOk) {
      noteFailure(ip);
      return bad('Benutzername oder Passwort stimmt nicht.', 401);
    }
    recentFailures.delete(ip);
    const token = await createSession(env, String(env.ADMIN_EMAIL).toLowerCase());
    return json(
      { ok: true, email: String(env.ADMIN_EMAIL).toLowerCase() },
      200,
      { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}` }
    );
  }

  if (path === 'logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
  }

  if (path === 'session' && method === 'GET') {
    const session = await readSession(env, cookieValue(request, COOKIE));
    return json({
      authenticated: Boolean(session),
      email: session?.email || null,
      mail: canMailAnyone(env),
      linkOnly: String(env.LINK_ONLY || '') === '1',
      translation: Boolean(env.AI),
      notify: Boolean((env.RESEND_API_KEY || env.BREVO_API_KEY) && env.NOTIFY_EMAIL),
      notifyEmail: env.NOTIFY_EMAIL || '',
      retentionDays: Number(env.RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    });
  }

  /* --- Signaturstrecke (ohne Anmeldung, nur mit Token) --------------- */

  if (segments[0] === 'sign' && segments[1]) {
    const token = segments[1];
    const pointer = await env.DOCS.get(`t/${token}`);
    if (!pointer) return bad('Dieser Link ist nicht mehr gültig.', 404);
    const id = await pointer.text();
    const doc = await readJson(env, `d/${id}/meta.json`);
    if (!doc) return bad('Dieser Link ist nicht mehr gültig.', 404);

    if (!segments[2] && method === 'GET') {
      if (doc.status !== 'completed') {
        doc.events.push(auditContext(request, { type: 'opened' }));
        if (doc.status === 'ready' || doc.status === 'sent') doc.status = 'opened';
        await writeJson(env, `d/${id}/meta.json`, doc);
        await updateIndex(env, doc);
      }
      return json({
        title: doc.title,
        language: doc.language || 'de',
        completed: doc.status === 'completed',
        pageCount: doc.pageCount,
        banner: doc.banner || '',
        translation: Boolean(doc.translationEnabled && doc.translation?.ready),
        signer: { name: doc.signer?.name || '' },
        fields: (doc.fields || []).map((f) => ({
          id: f.id, page: f.page, type: f.type, label: f.label,
          x: f.x, y: f.y, w: f.w, h: f.h,
          filledBy: f.filledBy, value: f.filledBy === 'admin' ? f.value : '',
          required: f.required !== false,
        })),
      });
    }

    if (segments[2] === 'file' && method === 'GET') {
      const wantSigned = doc.status === 'completed';
      const object = await env.DOCS.get(`d/${id}/${wantSigned ? 'signed' : 'original'}.pdf`);
      if (!object) return bad('Datei nicht gefunden.', 404);
      return pdfResponse(object, doc.title + (wantSigned ? ' (unterschrieben)' : ''), url.searchParams.get('inline') === '1');
    }

    if (segments[2] === 'complete' && method === 'POST') {
      if (doc.status === 'completed') return bad('Dieser Vorgang ist bereits abgeschlossen.', 409);
      const form = await request.formData();
      const file = form.get('pdf');
      const payload = JSON.parse(form.get('payload') || '{}');
      if (!file || typeof file === 'string') return bad('Das unterschriebene Dokument fehlt.');

      const bytes = await file.arrayBuffer();
      if (bytes.byteLength < 500) return bad('Das unterschriebene Dokument ist unbrauchbar.');
      await env.DOCS.put(`d/${id}/signed.pdf`, bytes, { httpMetadata: { contentType: 'application/pdf' } });

      const context = auditContext(request);
      for (const field of doc.fields || []) {
        if (field.type === 'note') continue;
        const value = field.filledBy === 'admin' ? field.value : payload.values?.[field.id];
        if (!value) continue;
        doc.events.push({
          ...context,
          type: 'field_signed',
          fieldId: field.id,
          detail: `${field.label || field.type} (Seite ${field.page + 1})`
            + (field.filledBy === 'admin' ? ' — vom Vermittler vorbelegt' : ''),
          method: field.type === 'signature' ? (payload.methods?.[field.id] || 'drawn') : 'typed',
          value: field.type === 'signature' ? value : undefined,
          textValue: field.type === 'signature' ? undefined : value,
        });
      }

      doc.hashSigned = String(payload.hash || '');
      doc.completedAt = new Date().toISOString();
      doc.status = 'completed';
      doc.events.push({ ...context, type: 'completed', detail: `Prüfsumme: ${doc.hashSigned.slice(0, 16)}…` });
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);

      if (env.NOTIFY_EMAIL) {
        ctx.waitUntil(notifyBroker(env, doc, url, bytes).catch(() => {}));
      }
      return json({ ok: true });
    }

    if (segments[2] === 'translation' && method === 'GET') {
      if (!doc.translationEnabled || !doc.translation?.ready) return bad('Keine Übersetzung verfügbar.', 404);
      const stored = await readJson(env, `d/${id}/translation-hu.json`);
      if (!stored) return bad('Keine Übersetzung verfügbar.', 404);
      if (!(doc.events || []).some((e) => e.type === 'translation_viewed')) {
        doc.events.push(auditContext(request, { type: 'translation_viewed', detail: 'Ungarische Übersetzung durch den Unterzeichner geöffnet' }));
        await writeJson(env, `d/${id}/meta.json`, doc);
      }
      return json({ pages: stored.pages || [] });
    }

    if (segments[2] === 'downloaded' && method === 'POST') {
      const kind = url.searchParams.get('kind');
      const detail = kind === 'original'
        ? 'Unsigniertes Original vor der Unterschrift heruntergeladen'
        : kind === 'translation'
          ? 'Ungarische Übersetzung als PDF heruntergeladen'
          : 'Unterschriebenes Dokument heruntergeladen';
      doc.events.push(auditContext(request, { type: 'downloaded', detail: detail + ' (durch den Unterzeichner)' }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      return json({ ok: true });
    }

    return bad('Unbekannter Aufruf.', 404);
  }

  /* --- ab hier nur angemeldet ---------------------------------------- */

  const session = await readSession(env, cookieValue(request, COOKIE));
  if (!session) return bad('Nicht angemeldet', 401);

  if (path === 'ai-test' && method === 'POST') {
    const model = env.TRANSLATION_MODEL || DEFAULT_TRANSLATION_MODEL;
    if (!env.AI) return json({ ok: false, model, error: 'Workers AI ist nicht eingebunden (Eintrag "ai" fehlt in wrangler.jsonc).' });
    const started = Date.now();
    try {
      const text = await translateChunk(env, model, 'Guten Tag, bitte unterschreiben Sie das beiliegende Dokument.');
      return json({ ok: true, model, ms: Date.now() - started, text });
    } catch (err) {
      return json({ ok: false, model, ms: Date.now() - started, error: aiErrorMessage(err), raw: String(err?.message || err).slice(0, 300) });
    }
  }

  if (path === 'templates' && method === 'GET') {
    return json((await readJson(env, 'templates.json')) || []);
  }

  if (path === 'templates' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return bad('Die Vorlage braucht einen Namen.');
    const list = (await readJson(env, 'templates.json')) || [];
    if (list.length >= 100) return bad('Es sind höchstens 100 Vorlagen möglich.');
    const tpl = {
      id: makeId(10),
      name: name.slice(0, 120),
      kind: body.kind === 'fields' ? 'fields' : 'builder',
      payload: body.payload || {},
      createdAt: new Date().toISOString(),
    };
    list.unshift(tpl);
    await writeJson(env, 'templates.json', list);
    return json(tpl);
  }

  if (segments[0] === 'templates' && segments[1] && method === 'DELETE') {
    const list = (await readJson(env, 'templates.json')) || [];
    const next = list.filter((t) => t.id !== segments[1]);
    if (next.length === list.length) return bad('Vorlage nicht gefunden.', 404);
    await writeJson(env, 'templates.json', next);
    return json({ ok: true });
  }

  if (path === 'documents' && method === 'GET') {
    const list = await loadIndex(env);
    list.sort((a, b) => {
      const ad = a.status === 'completed' ? 1 : 0;
      const bd = b.status === 'completed' ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt);
    });
    return json(list);
  }

  if (path === 'documents' && method === 'POST') {
    const title = (url.searchParams.get('title') || 'Neuer Vorgang').trim().slice(0, 160);
    const pageCount = Number(url.searchParams.get('pages') || 1);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 500) return bad('Es wurde kein brauchbares PDF empfangen.');
    if (bytes.byteLength > 15 * 1024 * 1024) return bad('Das Dokument ist größer als 15 MB.');

    const id = makeId();
    await env.DOCS.put(`d/${id}/original.pdf`, bytes, { httpMetadata: { contentType: 'application/pdf' } });

    let initialFields = [];
    const packed = url.searchParams.get('fields');
    if (packed) {
      try {
        initialFields = JSON.parse(decodeURIComponent(packed)).map((f) => ({
          id: makeId(8),
          page: Number(f.page) || 0,
          type: f.type,
          label: String(f.label || '').slice(0, 300),
          x: clamp(f.x), y: clamp(f.y), w: clamp(f.w), h: clamp(f.h),
          filledBy: f.filledBy === 'admin' ? 'admin' : 'customer',
          value: String(f.value || '').slice(0, 200),
          required: f.required !== false,
        }));
      } catch (_) { initialFields = []; }
    }

    const doc = {
      id,
      title,
      pageCount,
      createdAt: new Date().toISOString(),
      status: 'draft',
      fields: initialFields,
      signer: { salutation: 'herr', name: '', email: '' },
      language: 'de',
      token: null,
      hashOriginal: url.searchParams.get('hash') || '',
      events: [auditContext(request, {
        type: 'created',
        detail: url.searchParams.get('built')
          ? 'Im Baukasten erstellt'
          : url.searchParams.get('merged')
            ? `${url.searchParams.get('merged')} Dateien zusammengeführt`
            : 'Datei hochgeladen',
      })],
    };
    await writeJson(env, `d/${id}/meta.json`, doc);
    await updateIndex(env, doc);
    return json(doc);
  }

  if (segments[0] === 'documents' && segments[1]) {
    const id = segments[1];
    const doc = await readJson(env, `d/${id}/meta.json`);
    if (!doc) return bad('Vorgang nicht gefunden.', 404);
    const action = segments[2];

    if (!action && method === 'GET') return json(doc);

    if (!action && method === 'DELETE') {
      if (doc.status === 'completed' && url.searchParams.get('confirmed') !== '1') {
        return bad('Unterschriebene Vorgänge nur mit ausdrücklicher Bestätigung löschen.', 409);
      }
      await removeDocument(env, id, doc.token);
      return json({ ok: true });
    }

    if (!action && method === 'PUT') {
      if (doc.status === 'completed') return bad('Der Vorgang ist bereits abgeschlossen.', 409);
      const body = await request.json().catch(() => ({}));
      const allowed = ['signature', 'text', 'place', 'date', 'place_date', 'note'];
      if (Array.isArray(body.fields)) {
        if (body.fields.some((f) => !allowed.includes(f.type))) return bad('Unbekannter Feldtyp.');
        doc.fields = body.fields.map((f) => ({
          id: f.id || makeId(8),
          page: Number(f.page) || 0,
          type: f.type,
          label: String(f.label || '').slice(0, 300),
          x: clamp(f.x), y: clamp(f.y), w: clamp(f.w), h: clamp(f.h),
          filledBy: f.filledBy === 'admin' ? 'admin' : 'customer',
          value: String(f.value || '').slice(0, 200),
          required: f.required !== false,
        }));
      }
      if (body.signer) doc.signer = { ...doc.signer, ...body.signer };
      if (body.language === 'de' || body.language === 'hu') doc.language = body.language;
      if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 160);
      if (typeof body.banner === 'string') doc.banner = body.banner.trim().slice(0, 600);
      if (typeof body.translationEnabled === 'boolean') doc.translationEnabled = body.translationEnabled;
      doc.events.push(auditContext(request, { type: 'fields_saved', detail: `${doc.fields.length} Feld(er)` }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json(doc);
    }

    if (action === 'translate' && method === 'POST') {
      if (!env.AI) return bad('Die Übersetzungsfunktion ist nicht eingerichtet (Workers AI fehlt in wrangler.jsonc).', 503);
      if (doc.status === 'completed') return bad('Der Vorgang ist bereits abgeschlossen.', 409);
      const body = await request.json().catch(() => ({}));
      const page = Number(body.page);
      if (!Number.isInteger(page) || page < 0 || page >= (doc.pageCount || 1) || page > 59) {
        return bad('Ungültige Seitenangabe.');
      }
      const text = String(body.text || '').slice(0, 15000);
      if (!text.trim()) return json({ page, text: '' });
      try {
        return json({ page, text: await translateText(env, text) });
      } catch (err) {
        return bad(aiErrorMessage(err), 502);
      }
    }

    if (action === 'translation' && method === 'GET') {
      return json((await readJson(env, `d/${id}/translation-hu.json`)) || { pages: [] });
    }

    if (action === 'translation' && method === 'PUT') {
      if (doc.status === 'completed') return bad('Der Vorgang ist bereits abgeschlossen.', 409);
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.pages)) return bad('Keine Seiten übergeben.');
      const initial = body.initial === true;
      const key = `d/${id}/translation-hu.json`;
      const stored = (await readJson(env, key)) || { createdAt: new Date().toISOString() };
      stored.pages = body.pages.slice(0, 60).map((t) => String(t || '').slice(0, 30000));
      stored.updatedAt = new Date().toISOString();
      stored.model = env.TRANSLATION_MODEL || DEFAULT_TRANSLATION_MODEL;
      stored.edited = !initial;
      await writeJson(env, key, stored);
      doc.translation = {
        ...(doc.translation || {}),
        ready: true,
        model: stored.model,
        createdAt: initial ? new Date().toISOString() : (doc.translation?.createdAt || new Date().toISOString()),
        edited: !initial,
      };
      doc.events.push(auditContext(request, initial
        ? { type: 'translation_created', detail: `Maschinelle Übersetzung ins Ungarische, ${doc.pageCount} Seite(n)` }
        : { type: 'translation_edited', detail: 'Übersetzung vom Vermittler überarbeitet' }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json({ ok: true });
    }

    if (action === 'title' && method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const title = String(body.title || '').trim();
      if (!title) return bad('Die Überschrift darf nicht leer sein.');
      doc.title = title.slice(0, 160);
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json({ ok: true, title: doc.title });
    }

    if (action === 'link' && method === 'POST') {
      const customerFields = (doc.fields || []).filter((f) => f.filledBy === 'customer' && f.type !== 'note');
      if (!customerFields.length) return bad('Es ist noch kein Feld für den Kunden definiert.');
      const body = await request.json().catch(() => ({}));
      if (body.language === 'de' || body.language === 'hu') doc.language = body.language;
      if (!doc.token) {
        doc.token = makeId(28);
        await env.DOCS.put(`t/${doc.token}`, id);
      }
      if (doc.status === 'draft') doc.status = 'ready';
      doc.events.push(auditContext(request, {
        type: 'link_created',
        detail: `Sprache: ${doc.language === 'hu' ? 'Ungarisch' : 'Deutsch'}`,
      }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json({ url: `${url.origin}/sign/${doc.token}`, token: doc.token, language: doc.language });
    }

    if (action === 'send' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.signer) doc.signer = { ...doc.signer, ...body.signer };
      if (body.language === 'de' || body.language === 'hu') doc.language = body.language;
      if (!doc.signer?.email) return bad('Für den Versand fehlt die E-Mail-Adresse.');
      if (!doc.token) {
        doc.token = makeId(28);
        await env.DOCS.put(`t/${doc.token}`, id);
      }
      const link = `${url.origin}/sign/${doc.token}`;
      if (!canMailAnyone(env)) {
        return bad(
          'Direkter Versand an Kunden ist nicht möglich: Es ist keine eigene Absenderdomain '
          + 'hinterlegt. Nutzen Sie „In meinem E-Mail-Programm öffnen" oder kopieren Sie den Link.',
          409
        );
      }
      const mail = signRequestMail(doc, link);
      let result;
      try {
        result = await sendMail(env, { to: doc.signer.email, toName: doc.signer.name, ...mail });
      } catch (err) {
        return bad('E-Mail konnte nicht versendet werden. ' + err.message, 502);
      }
      doc.sentAt = new Date().toISOString();
      if (doc.status === 'draft' || doc.status === 'ready') doc.status = 'sent';
      doc.events.push(auditContext(request, {
        type: 'email_sent',
        detail: `An ${doc.signer.email}${result.simulated ? ' — nur protokolliert, kein Versanddienst hinterlegt' : ''}`,
      }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json({ ...result, url: link });
    }

    if (action === 'handover' && method === 'POST') {
      // Der Vermittler hat den Link über sein eigenes Postfach verschickt.
      const body = await request.json().catch(() => ({}));
      doc.sentAt = new Date().toISOString();
      if (doc.status === 'draft' || doc.status === 'ready') doc.status = 'sent';
      doc.events.push(auditContext(request, {
        type: 'email_sent',
        detail: `An ${doc.signer?.email || '—'} — über das eigene E-Mail-Programm des Vermittlers`
          + (body.via ? '' : ''),
      }));
      await writeJson(env, `d/${id}/meta.json`, doc);
      await updateIndex(env, doc);
      return json({ ok: true });
    }

    if (action === 'preview-mail' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const preview = { ...doc, signer: { ...doc.signer, ...(body.signer || {}) }, language: body.language || doc.language };
      return json(signRequestMail(preview, `${url.origin}/sign/${doc.token || 'VORSCHAU'}`));
    }

    if (action === 'file' && method === 'GET') {
      const signed = url.searchParams.get('signed') === '1';
      const object = await env.DOCS.get(`d/${id}/${signed ? 'signed' : 'original'}.pdf`);
      if (!object) return bad('Datei nicht gefunden.', 404);
      return pdfResponse(object, doc.title + (signed ? ' (unterschrieben)' : ''), url.searchParams.get('inline') === '1');
    }

    return bad('Unbekannter Aufruf.', 404);
  }

  return bad('Unbekannter Aufruf.', 404);
}

function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function pdfResponse(object, title, inline) {
  const name = (title || 'Dokument').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60) + '.pdf';
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}

async function notifyBroker(env, doc, url, signedBytes) {
  const subject = `Neue Unterschrift eingegangen: ${doc.title}`;
  const adminLink = `${url.origin}/`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;padding:32px">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#86868b">Unterschrift eingegangen</p>
    <h1 style="margin:0 0 18px;font-size:21px;font-weight:600">${escapeHtml(doc.title)}</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#3a3a3c">
      ${escapeHtml(doc.signer?.name || 'Ein Kunde')} hat den Vorgang abgeschlossen.<br>
      Bitte laden Sie das Dokument und das Protokoll herunter und sichern Sie beides lokal.
    </p>
    <a href="${adminLink}" style="display:inline-block;background:#0071e3;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:980px">Vorgang öffnen</a>
  </div></body></html>`;
  const attachments = [];
  // Nur bis 4 MB anhängen — größere Dateien würden die Rechenzeit sprengen.
  if (signedBytes && signedBytes.byteLength <= 4 * 1024 * 1024) {
    const safe = (doc.title || 'Dokument').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 60);
    attachments.push({
      filename: `${safe} (unterschrieben).pdf`,
      base64: toBase64(signedBytes),
    });
  }
  return sendMail(env, {
    to: env.NOTIFY_EMAIL,
    subject,
    html,
    text: `${doc.signer?.name || 'Ein Kunde'} hat "${doc.title}" unterschrieben. Öffnen: ${adminLink}`,
    attachments,
  });
}
