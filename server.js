// server.js — Yemot voice bot + Gemini
// Requires Node.js 18+ and express.
// Environment variables are read at process startup; restart the Render service after changing them.

'use strict';

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// -------------------------------
// Configuration
// -------------------------------

const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);

const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TEXT_MODEL_FALLBACK = process.env.TEXT_MODEL_FALLBACK || '';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const TTS_MODEL_FALLBACK = process.env.TTS_MODEL_FALLBACK || '';
const VOICE = process.env.VOICE || 'Kore';

const EXT = (process.env.EXT_PATH || '7').replace(/^\/+|\/+$/g, '');
const HISTORY_EXT = String(process.env.HISTORY_EXT || '4').replace(/^\/+|\/+$/g, '');

const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD
    ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD
    : '');

const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE ||
  'https://generativelanguage.googleapis.com/v1beta/models/';

const BUDGET = Math.max(15000, Number(process.env.TURN_BUDGET_MS) || 40000);
const SEARCH = String(process.env.WEB_SEARCH || '1') !== '0';
const SEARCH_AUTO = String(process.env.SEARCH_MODE || 'phrase') === 'auto';

const siteList = v => keyList(v)
  .map(x => x.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase())
  .filter(x => /^[a-z0-9.-]+$/.test(x));

const SITES = siteList(process.env.SEARCH_SITES);
const URLS = keyList(process.env.SEARCH_URLS)
  .filter(x => /^https?:\/\/\S+$/i.test(x))
  .slice(0, 10);

const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);
const MAXW = Math.min(300, Math.max(5, parseInt(process.env.MAX_WORDS, 10) || 25));

const EXTRA = String(process.env.EXTRA_INSTRUCTION || '')
  .replace(/\s+/g, ' ').trim().slice(0, 2000);

const VOICE_SET = {
  male: process.env.VOICE_MALE || 'Puck',
  female: process.env.VOICE_FEMALE || 'Kore',
  deep: process.env.VOICE_DEEP || 'Charon',
  soft: process.env.VOICE_SOFT || 'Aoede'
};

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות תמיד בגובה העיניים: בלי קללות, גסות או פגיעה במשתמש. אל תתנצל על הסגנון.',
  '2': 'האופי שלך: חכם ויעיל. ענה ישר לעניין, בלי הקדמות ובלי חזרה על השאלה. אם חסר מידע, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת ואל תמציא עובדות.',
  '3': 'האופי שלך: חבר קרוב. דבר בעברית יומיומית, חמה ונעימה, בגובה העיניים, עם הומור טוב לב. עודד והקשב בלי להתחנף ובלי נאומים.'
};

const MODE = MODES[String(process.env.MODE || '2')] ? String(process.env.MODE || '2') : '2';

const DEFAULT_GREET = 'הקלט את ההודעה בסיום הקש סולמית';
const AGAIN = 'לא שמעתי שאל שוב';
const ERR = 'הייתה תקלה נסו שוב';

const voiceRule =
  'אם המשתמש מבקש לשנות את הקול, התחל בתג אחד בלבד: ' +
  '[[VOICE:male]] לקול גבר, [[VOICE:female]] לקול אישה, ' +
  '[[VOICE:deep]] לקול עמוק, [[VOICE:soft]] לקול רך. ' +
  'אחרי התג אשר בקצרה. אל תשתמש בתג במקרה אחר. ';

const memoryRule =
  'בתחילת כל תשובה כתוב תג [[Q:תמלול קצר ונאמן של דברי המשתמש]] ' +
  'ואחריו התשובה. התג אינו מושמע. ';

function searchRule(sites = SITES) {
  let r = SEARCH_AUTO
    ? 'השתמש בחיפוש רק אם השאלה דורשת מידע עדכני או אם המשתמש ביקש חיפוש. '
    : 'השתמש בחיפוש באינטרנט רק אם המשתמש ביקש זאת במפורש. אחרת ענה מהידע שלך. ';
  if (sites.length) r += 'העדף את האתרים האלה: ' + sites.join(' ') + '. ';
  if (URLS.length) r += 'בעת חיפוש בדוק גם את הדפים האלה: ' + URLS.join(' ') + '. ';
  return r;
}

function buildSys(mode, extra, sites = SITES) {
  return 'אתה עוזר קולי בטלפון. ' +
    MODES[MODES[String(mode)] ? String(mode) : '2'] + ' ' +
    'ענה בעברית בקצרה ובבהירות, בעד ' + MAXW + ' מילים. ' +
    searchRule(sites) + voiceRule + memoryRule +
    (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
    (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '');
}

// -------------------------------
// Extension configuration
// -------------------------------

let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (_) { CFG = []; }

if (!Array.isArray(CFG) || !CFG.length) {
  CFG = [{ p: EXT, m: MODE, x: '', g: process.env.GREETING || '' }];
}

const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p,
    d: '/' + p,
    sys: buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      c.s ? siteList(c.s) : SITES),
    g: cleanYemotText(String(c.g || '').slice(0, 300)) || cleanYemotText(DEFAULT_GREET)
  };
}

const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || {
  p: EXT, d: '/' + EXT, sys: buildSys(MODE, ''), g: cleanYemotText(DEFAULT_GREET)
};

// -------------------------------
// General helpers
// -------------------------------

function cleanYemotText(s) {
  return String(s)
    .replace(/[.\-"'&|,=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isBudget = e => e && /budget exhausted/i.test(e.message || '');
const rot = { text: 0, tts: 0 };
const calls = {};

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) {
    if (now - calls[id].t > 3600000) {
      if (calls[id].r) del(calls[id].r, calls[id].d);
      delete calls[id];
    }
  }
}, 600000).unref();

async function http(url, opt = {}, ms = 10000, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) throw new Error('turn budget exhausted');
  return fetch(url, {
    ...opt,
    signal: AbortSignal.timeout(Math.max(800, Math.min(ms, left)))
  });
}

function phoneDigits(q) {
  return String(q.ApiPhone || q.phone || '').replace(/\D/g, '').slice(-20);
}

function historyPath(phone) {
  return 'ivr2:/' + HISTORY_EXT + '/history_' + phone + '.txt';
}

function yp(name, d) {
  return 'ivr2:' + (d === undefined ? '/' + EXT : d) + '/' + name + '.wav';
}

// -------------------------------
// Persistent conversation history
// -------------------------------

const HISTORY_LIMIT = Math.max(5, Math.min(50, parseInt(process.env.HISTORY_LIMIT, 10) || 20));

async function loadHistoryStore(phone, deadline) {
  if (!phone || !TOKEN) return { sessions: [], pendingSessionId: '' };
  try {
    const url = YM + 'GetTextFile?token=' + encodeURIComponent(TOKEN) +
      '&what=' + encodeURIComponent(historyPath(phone));
    const r = await http(url, {}, 8000, deadline);
    if (!r.ok) return { sessions: [], pendingSessionId: '' };
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus && j.responseStatus !== 'OK') {
      return { sessions: [], pendingSessionId: '' };
    }
    const data = JSON.parse(j.contents || '{}');
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions.slice(-HISTORY_LIMIT) : [],
      pendingSessionId: String(data.pendingSessionId || '')
    };
  } catch (e) {
    console.error('history load failed:', e.message);
    return { sessions: [], pendingSessionId: '' };
  }
}

async function saveHistoryStore(phone, store, deadline) {
  if (!phone || !TOKEN) return;
  const contents = JSON.stringify({
    sessions: (store.sessions || []).slice(-HISTORY_LIMIT),
    pendingSessionId: String(store.pendingSessionId || '')
  });
  const url = YM + 'UploadTextFile?token=' + encodeURIComponent(TOKEN) +
    '&what=' + encodeURIComponent(historyPath(phone)) +
    '&contents=' + encodeURIComponent(contents);
  const r = await http(url, {}, 10000, deadline);
  const raw = await r.text();
  if (!r.ok || /error|fail/i.test(raw)) {
    throw new Error('UploadTextFile failed: ' + raw.slice(0, 180));
  }
}

function historySession(store, id) {
  return (store.sessions || []).find(x => String(x.id) === String(id));
}

function historyMenu(sessions) {
  return sessions.slice()
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 9)
    .map((s, i) => (i + 1) + ' ' +
      (cleanYemotText(String(s.title || 'שיחה')).slice(0, 45) || 'שיחה'))
    .join('. ');
}

// -------------------------------
// Gemini diagnostics and retry logic
// -------------------------------

const THINK = ['minimal', 'low', null];
let thinkIdx = 0;
let searchOk = SEARCH;
let urlOk = true;

function parseRetryDelay(body, headers) {
  const retryAfter = headers && headers.get && headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    const details = obj && obj.error && obj.error.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d.retryDelay) {
          const m = /^([\d.]+)s$/.exec(String(d.retryDelay));
          if (m) return Number(m[1]) * 1000;
        }
      }
    }
  } catch (_) {}
  return 0;
}

function isQuotaExhausted(message) {
  return /quota_exceeded|daily quota|exceeded your current quota|billing|spend.?limit/i.test(message || '');
}

function safeErrorBody(raw) {
  try {
    const j = JSON.parse(raw);
    return {
      message: j.error && j.error.message ? j.error.message : raw.slice(0, 500),
      status: j.error && j.error.status ? j.error.status : '',
      details: j.error && j.error.details ? j.error.details : []
    };
  } catch (_) {
    return { message: raw.slice(0, 500), status: '', details: [] };
  }
}

async function gemOnce(model, body, deadline, pool) {
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');

  let lastError;
  const maxAttempts = Math.min(3, Math.max(1, list.length));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = list[rot[pool]++ % list.length];
    const started = Date.now();

    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, 25000, deadline);

      if (r.ok) return await r.json();

      const raw = await r.text();
      const info = safeErrorBody(raw);
      const msg = model + ' HTTP ' + r.status + ' ' + info.message;
      const retryMs = parseRetryDelay(raw, r.headers);

      lastError = new Error(msg);
      lastError.status = r.status;
      lastError.retryMs = retryMs;
      lastError.quotaExhausted = isQuotaExhausted(info.message);
      lastError.apiStatus = info.status;
      lastError.apiDetails = info.details;

      console.error('Gemini request failed', JSON.stringify({
        model, pool, status: r.status, apiStatus: info.status,
        retryMs, quotaExhausted: lastError.quotaExhausted,
        elapsedMs: Date.now() - started, message: info.message.slice(0, 350)
      }));

      // 400/401/403/404 are not fixed by rotating API keys.
      if (![429, 500, 502, 503, 504].includes(r.status)) break;

      // A project quota or billing exhaustion will affect all keys in that project.
      if (r.status === 429 && lastError.quotaExhausted) break;

      if (attempt < maxAttempts - 1) {
        const delay = Math.min(8000, Math.max(retryMs, 700 * Math.pow(2, attempt)));
        if (deadline && Date.now() + delay + 1000 >= deadline) break;
        await sleep(delay);
      }
    } catch (e) {
      if (isBudget(e)) throw e;
      lastError = e;
      if (e.status && ![429, 500, 502, 503, 504].includes(e.status)) break;
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(5000, 700 * Math.pow(2, attempt));
        if (deadline && Date.now() + delay + 1000 >= deadline) break;
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error(model + ' failed');
}

async function gem(model, body, deadline, pool = 'text') {
    try {
    return await gemOnce(model, body, deadline, pool);
  } catch (e) {
    const fallback = pool === 'tts' ? TTS_MODEL_FALLBACK : TEXT_MODEL_FALLBACK;
    if (!fallback || fallback === model) throw e;
    if (![429, 500, 502, 503, 504].includes(e.status || 0)) throw e;
    console.warn('Trying configured fallback model', {
      primary: model, fallback, status: e.status,
      quotaExhausted: !!e.quotaExhausted
    });
    return await gemOnce(fallback, body, deadline, pool);
  }
}

function generationConfig() {
  const cfg = { maxOutputTokens: 1024 };
  if (THINK[thinkIdx]) cfg.thinkingConfig = { thinkingLevel: THINK[thinkIdx] };
  return cfg;
}

async function textGen(body, deadline, wantSearch = false) {
  for (;;) {
    const req = { ...body, generationConfig: generationConfig() };
    const tools = [];
    const useSearch = !!(SEARCH && wantSearch && searchOk);
    const useUrl = !!(useSearch && URLS.length && urlOk);

    if (useSearch) tools.push({ google_search: {} });
    if (useUrl) tools.push({ url_context: {} });
    if (tools.length) req.tools = tools;

    try {
      return await gem(TEXT_MODEL, req, deadline, 'text');
    } catch (e) {
      if (useUrl && e.status === 400 && /url.?context/i.test(e.message)) {
        urlOk = false;
        console.warn('URL context disabled after unsupported-tool response');
        continue;
      }
      if (useSearch && e.status === 400 && /tool|search|ground/i.test(e.message)) {
        searchOk = false;
        console.warn('Google Search tool disabled after unsupported-tool response');
        continue;
      }
      if (e.status === 400 && /think/i.test(e.message) && thinkIdx < THINK.length - 1) {
        thinkIdx++;
        console.warn('Retrying without unsupported thinking level:', THINK[thinkIdx] || 'default');
        continue;
      }
      throw e;
    }
  }
}

// -------------------------------
// Explicit-search phrase detector (also used by diagnostics)
// -------------------------------

function explicitlyRequestsSearch(text) {
  const s = String(text || '').toLowerCase();
  if (SEARCH_AUTO) return true;
  return /(חפש|חיפוש|תחפש|תבדוק באינטרנט|תבדוק ברשת|תבדוק באתר|תמצא באינטרנט|חפש בגוגל|בדוק באינטרנט|בדוק באתר|search (the )?(web|internet|online|google)|look up online|find (it )?online|check (this )?website)/i.test(s);
}

// -------------------------------
// WAV and TTS
// -------------------------------

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function voiceVariants(v) {
  // Gemini TTS uses prebuiltVoiceConfig.voiceName in the documented GenerateContent format.
  return [{ prebuiltVoiceConfig: { voiceName: v } }];
}

async function tts(text, deadline, voice) {
  const selectedVoice = voice || VOICE;
  let last = new Error('no audio from tts');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await gem(TTS_MODEL, {
        contents: [{ role: 'user', parts: [{ text: String(text).slice(0, 800) }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: voiceVariants(selectedVoice)[0] }
        }
      }, deadline, 'tts');

      const parts = (((result.candidates || [])[0] || {}).content || {}).parts || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (part) {
        let audio = Buffer.from(part.inlineData.data, 'base64');
        if (audio.subarray(0, 4).toString() !== 'RIFF') {
          const rateMatch = /rate=(\d+)/i.exec(part.inlineData.mimeType || '');
          audio = wav(audio, rateMatch ? Number(rateMatch[1]) : 24000);
        }
        return audio;
      }
      last = new Error('no audio returned by TTS model');
    } catch (e) {
      last = e;
      if (isBudget(e)) throw e;
      if (e.status && ![429, 500, 502, 503, 504].includes(e.status)) throw e;
    }
    if (attempt === 0) await sleep(500);
  }
  throw last;
}

// -------------------------------
// Yemot file transfer
// -------------------------------

async function download(name, deadline, d) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(
        YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) +
          '&path=' + encodeURIComponent(yp(name, d)),
        {}, 8000, deadline
      );
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 100).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
    await sleep(400);
  }
  throw new Error('download failed ' + last);
}

async function upload(name, buf, deadline, d) {
  const path = yp(name, d);
  const attempts = [
    { query: true, field: 'file' },
    { query: true, field: 'upload' },
    { query: false, field: 'upload' },
    { query: false, field: 'file' }
  ];
  let last = '';

  for (const a of attempts) {
    try {
      const form = new FormData();
      let url = YM + 'UploadFile';
      if (a.query) {
        url += '?token=' + encodeURIComponent(TOKEN) +
          '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        form.append('token', TOKEN);
        form.append('path', path);
        form.append('convertAudio', '1');
      }
      form.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: form }, 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 220);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('upload failed ' + last);
}

function del(name, d) {
  if (!name || !TOKEN) return;
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) +
    '&action=delete&what=' + encodeURIComponent(yp(name, d)),
    { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

// -------------------------------
// Greeting file detection
// -------------------------------

const greetOk = {};

async function greetFile(d, deadline) {
  if (greetOk[d] !== undefined) return greetOk[d];
  try {
    const r = await http(
      YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) +
        '&path=' + encodeURIComponent('ivr2:' + d),
      {}, 3500, deadline
    );
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') return false;
    greetOk[d] = JSON.stringify(j).includes('greet.wav');
    return greetOk[d];
  } catch (_) {
    return false;
  }
}

// -------------------------------
// Routes
// -------------------------------

app.get('/', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').send('ok');
});

// Regex route accepts nested Yemot extension paths too, e.g. /yemot/1/2.
app.all(/^\/yemot(?:\/(.*))?$/, async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
  res.type('text/plain; charset=utf-8');

  const startedAt = Date.now();
  const requestedExt = String(req.params[0] || '').replace(/^\/+|\/+$/g, '');
  const extKey = requestedExt.replace(/\//g, '_');
  const ext = EXTS[extKey] || EXT_FIRST;

  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r, old.d);
      delete calls[id];
      return res.send('noop=bye');
    }

    // Extension for selecting a saved conversation.
    if (requestedExt === HISTORY_EXT) {
      const phone = phoneDigits(q);
      if (!phone) return res.send('id_list_message=t-לא זיהיתי את מספר הטלפון שלך');

      const deadline = Date.now() + BUDGET;
      const store = await loadHistoryStore(phone, deadline);
      const sessions = (store.sessions || [])
        .slice()
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 9);

      if (!sessions.length) {
        return res.send('id_list_message=t-עדיין אין שיחות שמורות. חזור לשלוחה ' + EXT + ' כדי להתחיל שיחה חדשה');
      }

      if (q.HSEL) {
        const n = parseInt(String(q.HSEL), 10);
        const selected = sessions[n - 1];
        if (!selected) {
          return res.send('read=t-הבחירה לא תקינה. ' + historyMenu(sessions) +
            ' הקש מספר שיחה=HSEL,,1,1,7,No,yes,yes,,,,,Ok');
        }
        store.pendingSessionId = String(selected.id);
        await saveHistoryStore(phone, store, deadline);
        return res.send('id_list_message=t-השיחה נבחרה. ממשיכים מאותה נקודה&go_to_folder=/' + EXT);
      }

      return res.send('read=t-לבחירת שיחה קודמת, הקש את המספר המתאים. ' +
        historyMenu(sessions) +
        ' הקש מספר שיחה=HSEL,,1,1,7,No,yes,yes,,,,,Ok');
    }

    const s = calls[id] || (calls[id] = {
      d: ext.d, sys: ext.sys, g: ext.g, n: 0, h: [],
      p: '', name: '', r: '', t: 0,
      e: crypto.randomBytes(3).toString('hex'),
      phone: phoneDigits(q), historyLoaded: false,
      historyStore: null, sessionId: '', voice: VOICE
    });

    s.t = Date.now();
    if (!s.phone) s.phone = phoneDigits(q);

    if (!s.historyLoaded) {
      s.historyStore = await loadHistoryStore(s.phone, Date.now() + 10000);
      const chosen = historySession(s.historyStore, s.historyStore.pendingSessionId);

      if (chosen) {
        s.sessionId = String(chosen.id);
        s.h = (chosen.messages || []).slice(-12).map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: String(m.text || '') }]
        }));
        s.g = 'המשכנו שיחה קודמת. המשך מאותו הקשר ואל תתחיל מחדש.';
        s.historyStore.pendingSessionId = '';
        await saveHistoryStore(s.phone, s.historyStore, Date.now() + 10000);
      } else {
        s.sessionId = crypto.randomBytes(6).toString('hex');
      }
      s.historyLoaded = true;
    }

    const ask = pre => {
      s.n++;
      s.p = 'Q' + s.e + s.n;
      s.name = 'q' + s.e + 'n' + s.n;
      return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' +
        s.name + ',no,,,1,' + REC_MAX;
    };

    if (!s.name) {
      const hasGreetingFile = process.env.USE_GREET_FILE === '1' &&
        await greetFile(s.d, Date.now() + 4000);
      const greeting = hasGreetingFile ? 'f-' + s.d + '/greet' : 't-' + s.g;
      return res.send(ask(greeting));
    }

    if (!q[s.p]) return res.send(ask('t-' + cleanYemotText(AGAIN)));

    const deadline = startedAt + BUDGET;
    const questionFile = s.name;
    let output;

    try {
      const audio = await download(questionFile, deadline, s.d);
      del(questionFile, s.d);

      if (s.r) {
        del(s.r, s.d);
        s.r = '';
      }

      const t1 = Date.now();
      // One Gemini request per turn: the model hears the audio directly.
      // Google Search is available when enabled, but the system prompt instructs
      // the model to invoke it only for an explicit request (unless SEARCH_MODE=auto).
      const generated = await textGen({
        systemInstruction: { parts: [{ text: s.sys }] },
        contents: [
          ...s.h.slice(-8),
          { role: 'user', parts: [{ inlineData: {
            mimeType: 'audio/wav', data: audio.toString('base64')
          } }] }
        ]
      }, deadline, SEARCH);
            const parts = (((generated.candidates || [])[0] || {}).content || {}).parts || [];
      let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('empty answer ' + JSON.stringify(generated.promptFeedback || {}).slice(0, 120));

      const questionMatch = /\[\[Q:([\s\S]*?)\]\]/i.exec(text);
      const heard = questionMatch
        ? questionMatch[1].replace(/\s+/g, ' ').trim().slice(0, 500)
        : '[שאלה קולית]';

      const voiceMatch = /\[\[\s*VOICE\s*:\s*(\w+)\s*\]\]/i.exec(text);
      if (voiceMatch && VOICE_SET[voiceMatch[1].toLowerCase()]) {
        s.voice = VOICE_SET[voiceMatch[1].toLowerCase()];
      }
      text = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
      const t2 = Date.now();

      const pcm = await tts(text, deadline, s.voice);
      const t3 = Date.now();

      const responseFile = 'r' + s.e + 'n' + s.n;
      await upload(responseFile, pcm, deadline, s.d);
      s.r = responseFile;

      s.h.push(
        { role: 'user', parts: [{ text: heard }] },
        { role: 'model', parts: [{ text }] }
      );
      if (s.h.length > 12) s.h = s.h.slice(-12);

      if (s.phone) {
        try {
          const store = s.historyStore || await loadHistoryStore(s.phone, deadline);
          let session = historySession(store, s.sessionId);

          if (!session) {
            session = {
              id: s.sessionId || crypto.randomBytes(6).toString('hex'),
              title: heard.slice(0, 55) || 'שיחה חדשה',
              createdAt: Date.now(), updatedAt: Date.now(), messages: []
            };
            s.sessionId = session.id;
            store.sessions.push(session);
          }

          session.messages.push(
            { role: 'user', text: heard, at: Date.now() },
            { role: 'model', text, at: Date.now() }
          );
          session.messages = session.messages.slice(-40);
          session.updatedAt = Date.now();
          store.sessions = store.sessions
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
            .slice(0, HISTORY_LIMIT);
          s.historyStore = store;
          await saveHistoryStore(s.phone, store, deadline);
        } catch (historyError) {
          console.error(id, 'history save failed:', historyError.message);
        }
      }

      console.log(JSON.stringify({
        callId: id, turn: s.n, result: 'ok',
        transcriptMs: t2 - t1, answerAndTtsMs: t3 - t2,
        totalMs: Date.now() - startedAt, searchToolAvailable: SEARCH && searchOk,
        textModel: TEXT_MODEL, ttsModel: TTS_MODEL
      }));

      output = ask('f-' + s.d + '/' + responseFile);

    } catch (e) {
      console.error(JSON.stringify({
        callId: id, turn: s.n, result: 'failed',
        elapsedMs: Date.now() - startedAt,
        status: e.status || null, quotaExhausted: !!e.quotaExhausted,
        apiStatus: e.apiStatus || null,
        error: String(e.message || e).slice(0, 700)
      }));
      del(questionFile, s.d);
      output = ask('t-' + cleanYemotText(ERR));
    }

    return res.send(output);
  } catch (e) {
    console.error(id, 'fatal:', e.stack || e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + cleanYemotText(ERR));
  }
});

// -------------------------------
// Create a greeting recording
// -------------------------------

let lastRec = 0;

app.post('/record', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');

  try {
    if (String(req.body.token || '') !== TOKEN) {
      return res.send('ERR הטוקן לא תואם לטוקן ששמור בשירות');
    }
    if (Date.now() - lastRec < 6000) return res.send('ERR חכו כמה שניות ונסו שוב');

    const dir = String(req.body.dir || '').replace(/^\/+|\/+$/g, '');
    const file = String(req.body.file || 'greet');

    if (dir && !/^[0-9]+(\/[0-9]+)*$/.test(dir)) return res.send('ERR מספר שלוחה לא תקין');
    if (!/^[A-Za-z0-9_]{1,20}$/.test(file)) return res.send('ERR שם קובץ לא תקין');

    const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) return res.send('ERR הטקסט ריק');

    lastRec = Date.now();
    const d = dir ? '/' + dir : '';
    const deadline = Date.now() + 80000;
    const pcm = await tts(text, deadline);
    await upload(file, pcm, deadline, d);

    if (file === 'greet') greetOk[d] = true;
    res.send('OK ההקלטה נוצרה על ידי ג׳מיני והועלתה אל ' +
      (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') + ' בשם ' + file + '.wav (' +
      Math.round(pcm.length / 1024) + 'KB)');
  } catch (e) {
    console.error('/record failed:', e.message);
    res.send('ERR ' + String(e.message).slice(0, 250));
  }
});

// -------------------------------
// Health and diagnostics
// -------------------------------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    extension: EXT,
    historyExtension: HISTORY_EXT,
    textModel: TEXT_MODEL,
    textFallbackConfigured: !!TEXT_MODEL_FALLBACK,
    ttsModel: TTS_MODEL,
    ttsFallbackConfigured: !!TTS_MODEL_FALLBACK,
    webSearchEnabled: SEARCH,
    searchMode: SEARCH_AUTO ? 'auto' : 'explicit-request-only',
    voiceSwitching: true,
    historyEnabled: !!TOKEN,
    keysConfigured: KEYS.length,
    ttsKeysConfigured: TTS_KEYS.length
  });
});

let lastTest = 0;

app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastTest < 20000) return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  lastTest = Date.now();

  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try {
      out.push('OK  ' + name + (await fn() || ''));
    } catch (e) {
      out.push('ERR ' + name + ': ' + String(e.message).slice(0, 260));
    }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות Gemini לתמלול', async () => {
    if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק');
    return ' (' + KEYS.length + ')';
  });
  await step('מפתחות Gemini להקראה', async () => {
    if (!TTS_KEYS.length) throw new Error('GEMINI_TTS_KEYS ריק');
    return ' (' + TTS_KEYS.length + ')';
  });
  await step('טוקן ימות', async () => {
    if (!TOKEN) throw new Error('YEMOT_TOKEN ריק');
  });
  await step('ימות: קריאת שלוחה ' + EXT, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) +
      '&path=' + encodeURIComponent('ivr2:/' + EXT), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  await step('ימות: העלאה ומחיקה של קובץ בדיקה', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) +
      '&action=delete&what=' + encodeURIComponent(yp('selftest')),
      {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
  });
  await step('Gemini: בדיקת מודל טקסט', async () => {
    const a = await gem(TEXT_MODEL, {
      contents: [{ role: 'user', parts: [{ text: 'ענה במילה אחת: שלום' }] }],
      generationConfig: { maxOutputTokens: 32 }
    }, deadline, 'text');
    if (!(((a.candidates || [])[0] || {}).content)) throw new Error('תשובה ריקה');
    return ' (' + TEXT_MODEL + ')';
  });
  await step('Gemini: בדיקת TTS', async () => {
    const p = await tts('בדיקה', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });
  await step('בדיקת זיהוי בקשת חיפוש', async () => {
    const ordinary = explicitlyRequestsSearch('מה מזג האוויר?');
    const explicit = explicitlyRequestsSearch('חפש באינטרנט מה מזג האוויר');
    if (SEARCH_AUTO ? (ordinary && explicit) : (!ordinary && explicit)) return;
    throw new Error('בדיקת זיהוי חיפוש נכשלה');
  });

  res.send(out.join('\n'));
});

// -------------------------------
// Error handling and startup
// -------------------------------

app.use((err, req, res, next) => {
  console.error('Express error:', err && (err.stack || err.message));
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + cleanYemotText(ERR));
});

process.on('unhandledRejection', e => console.error('unhandledRejection:', e && (e.stack || e.message)));
process.on('uncaughtException', e => console.error('uncaughtException:', e && (e.stack || e.message)));

app.listen(process.env.PORT || 3000, () => {
  console.log(JSON.stringify({
    status: 'started',
    extension: EXT,
    historyExtension: HISTORY_EXT,
    textModel: TEXT_MODEL,
    textFallback: TEXT_MODEL_FALLBACK || null,
    ttsModel: TTS_MODEL,
    ttsFallback: TTS_MODEL_FALLBACK || null,
    webSearch: SEARCH,
    searchMode: SEARCH_AUTO ? 'auto' : 'explicit-request-only',
    voiceSwitching: true,
    textKeys: KEYS.length,
    ttsKeys: TTS_KEYS.length
  }));
});
