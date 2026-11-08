const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.urlencoded({ extended: true }));

// two separate key pools: GEMINI_API_KEYS for transcription (audio understanding), GEMINI_TTS_KEYS for read-aloud
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICE_MALE = process.env.VOICE_MALE || 'Charon';
const VOICE_FEMALE = process.env.VOICE_FEMALE || 'Kore';
const DEFAULT_VOICE = process.env.DEFAULT_VOICE === 'female' ? 'female' : 'male';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const HIST_EXT = (process.env.HIST_PATH || '4').replace(/^\/+|\/+$/g, '');
const HIST_DIR = '/' + HIST_EXT;
const TOKEN = process.env.YEMOT_TOKEN || (process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD);
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 40000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// where the conversation history is kept: Upstash Redis (survives restarts) or local files (lost on every restart on Render free)
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UP_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAXC = 8; // saved conversations per phone number (digits 1-8, digit 9 is a new conversation)

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();
// stricter cleaning for text that came from callers or from the model: only Hebrew, Latin letters and digits
const spx = s => sp(String(s || '').replace(/[^\u0590-\u05FFa-zA-Z0-9 ]/g, ' '));

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות היא תמיד בגובה העיניים וביד קלה: בלי קללות, בלי גסות, בלי פגיעה במשתמש, במשפחה, בדת או בעדה. אל תתנצל על הסגנון ואל תצא מהאופי הזה בשום מצב, גם אם ביקשו ממך.',
  '2': 'האופי שלך: חכם ויעיל. אתה מקצועי, מדויק וענייני, מהיר כמו מחשבון. ענה ישר לעניין, בלי הקדמות, בלי מילות מילוי ובלי חזרה על השאלה, במשפט הכי ברור ושימושי שאפשר. אם חסר מידע החלטי, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת במפורש ואל תמציא עובדות. אל תצא מהאופי הזה בשום מצב.',
  '3': 'האופי שלך: חבר קרוב. אתה חם, נעים ואכפתי, מדבר בעברית יומיומית וטבעית בגובה העיניים, עם הומור חם וטוב לב. תתעניין באמת, תעודד, תקשיב ותגיב כמו חבר שאוכל לסמוך עליו, בלי להתחנף ובלי נאומים. אל תצא מהאופי הזה בשום מצב.'
};
const MODE = MODES[String(process.env.MODE || '2')] ? String(process.env.MODE || '2') : '2';
const MAXW = Math.min(300, Math.max(5, parseInt(process.env.MAX_WORDS, 10) || 25));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
const buildSys = (mode, extra) => 'אתה עוזר קולי בטלפון. ' + MODES[MODES[String(mode)] ? String(mode) : '2'] +
  ' חובה מוחלטת: שמור על האופי הזה בכל תשובה ובכל סיבוב שיחה. ענה בעברית בקצרה ובבהירות, בעד ' + MAXW + ' מילים, בלי רשימות ובלי סימנים מיוחדים. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '');

// added to every turn: the model returns JSON so the server knows what was asked, which voice was requested and whether to search the web
const ROUTER = ' פורמט התשובה: החזר אך ורק אובייקט JSON תקין, בלי טקסט נוסף ובלי סימוני קוד, במבנה {"q":"","a":"","voice":"","search":false,"sq":""}. ' +
  'השדה q הוא תמלול קצר ומדויק של מה שהמשתמש אמר בהקלטה. ' +
  'השדה a הוא התשובה שלך בעברית, בלי רשימות ובלי סימנים מיוחדים. ' +
  'השדה voice: אם המשתמש ביקש במפורש שתדבר בקול נשי החזר female, אם ביקש קול גברי החזר male, אחרת מחרוזת ריקה. כשמבקשים רק להחליף קול, אשר זאת בקצרה בשדה a. ' +
  'השדה search: החזר true רק אם המשתמש ביקש במפורש לחפש באינטרנט או ברשת או לבדוק באתר, ובמקרה כזה השאר את a ריק. בכל מקרה אחר החזר false. כשsearch הוא true, השדה sq הוא ביטוי חיפוש קצר ומדויק של 2 עד 6 מילים, מתאים למנוע חיפוש, בלי מילות מילוי כמו חפש או באינטרנט. ' +
  'השיחה רציפה: שאלות המשך מתייחסות לשאלות ולתשובות הקודמות בשיחה, ענה בהתאם ואל תבקש מהמשתמש להסביר או להגדיר שוב.';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const GOOGLE_SEARCH = process.env.GOOGLE_SEARCH === '1'; // Gemini google_search grounding, off by default; falls back to free search when it fails
const SEARCH_MODEL = process.env.SEARCH_MODEL || ''; // optional separate model for grounding (own quota), for example gemini-2.5-flash
const SEARCH_W = Math.min(300, MAXW * 2);
const SEARCH_NOTE = ' ענה על סמך תוצאות החיפוש באינטרנט, בעברית, בעד ' + SEARCH_W + ' מילים, בלי כתובות אתרים, בלי מספרי הפניה ובלי סימנים מיוחדים. השיחה רציפה ושאלות המשך מתייחסות לתשובות הקודמות.';

// one entry per Yemot extension: its own character mode, extra instruction and opening message
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: process.env.MODE || '2', x: '', g: process.env.GREETING || '' }];
const DEFAULT_GREET = 'שלום אנא הקלט את ההודעה בסיום הקש סולמית';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p,
    sys: buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: sp(String(c.g || '').slice(0, 300)) || sp(DEFAULT_GREET)
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, sys: buildSys('2', ''), g: sp(DEFAULT_GREET) };
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');
const REC_HINT = sp('אפשר להקליט עכשיו את ההודעה ובסיום הקש סולמית');

const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + '.wav';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => e && /budget/.test(e.message || '');
const rot = { text: 0, tts: 0 };
const calls = {};

// drop state of calls that never sent hangup
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

// ---------- storage of users (voice choice + saved conversations), keyed by caller phone number ----------
const cache = new Map();
async function upstash(cmd) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(5000)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function getUser(phone) {
  if (cache.has(phone)) return cache.get(phone);
  let u = null;
  try {
    let raw = null;
    if (UP_URL && UP_TOK) raw = await upstash(['GET', 'zygy:u:' + phone]);
    else raw = await fs.promises.readFile(path.join(DATA_DIR, phone + '.json'), 'utf8').catch(() => null);
    if (raw) u = JSON.parse(raw);
  } catch (e) { console.error('store load', e.message); }
  if (!u || !Array.isArray(u.c)) u = { v: '', c: [] };
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(phone, u);
  return u;
}
function persist(phone, u) {
  const raw = JSON.stringify(u);
  (async () => {
    try {
      if (UP_URL && UP_TOK) await upstash(['SET', 'zygy:u:' + phone, raw]);
      else {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        await fs.promises.writeFile(path.join(DATA_DIR, phone + '.json'), raw);
      }
    } catch (e) { console.error('store save', e.message); }
  })();
}

const titleOf = t => spx(t).split(' ').filter(Boolean).slice(0, 6).join(' ') || 'ללא כותרת';
async function saveTurn(s, qText, text) {
  if (!s.phone) return;
  const u = await getUser(s.phone);
  let c = u.c.find(x => x.id === s.cid);
  if (!c) { c = { id: s.cid, title: titleOf(qText), ts: 0, turns: [] }; u.c.unshift(c); }
  c.ts = Date.now();
  c.turns.push({ q: String(qText || '').slice(0, 300), a: String(text || '').slice(0, 600) });
  if (c.turns.length > 40) c.turns = c.turns.slice(-40);
  u.c.sort((a, b) => b.ts - a.ts);
  u.c = u.c.slice(0, MAXC);
  u.v = s.v;
  persist(s.phone, u);
}
const histOf = turns => turns.slice(-8).flatMap(t => [
  { role: 'user', parts: [{ text: t.q || '[שאלה קולית]' }] },
  { role: 'model', parts: [{ text: t.a }] }
]);

// ---------- Gemini ----------
// fetch with a timeout that never exceeds the remaining time of the current turn
async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) throw new Error('turn budget exhausted');
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

async function gem(model, body, deadline, pool) {
  pool = pool || 'text';
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');
  let err = model + ' failed';
  let status = 0;
  for (let i = 0; i < list.length * 2; i++) {
    const key = list[rot[pool]++ % list.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, 25000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    await sleep(status === 429 ? 1500 : 500);
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// fastest thinking level the model accepts; remembered after the first call
const THINK = ['minimal', 'low', null];
let thinkIdx = 0;
// extra = extra generationConfig fields (for example responseMimeType); dropped automatically if the model rejects them
async function textGen(body, deadline, extra, model) {
  let ex = extra || null;
  for (;;) {
    const lvl = model ? null : THINK[thinkIdx]; // thinkingLevel only for the main model
    const gc = { maxOutputTokens: 1024, ...(ex || {}) };
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
    try {
      return await gem(model || TEXT_MODEL, { ...body, generationConfig: gc }, deadline, 'text');
    } catch (e) {
      if (!model && e.status === 400 && /think/i.test(e.message) && thinkIdx < THINK.length - 1) { thinkIdx++; continue; }
      if (e.status === 400 && ex && /mime|json|schema|response/i.test(e.message)) { ex = null; continue; }
      throw e;
    }
  }
}

// summary step after a web search: if the main model is over quota (429), retry with a second model that has its own quota
const SUM_ALT = process.env.SUMMARY_MODEL || SEARCH_MODEL || 'gemini-2.5-flash-lite';
async function sumGen(body, deadline) {
  try { return await textGen(body, deadline); }
  catch (e) {
    if (e.status === 429 && SUM_ALT && SUM_ALT !== TEXT_MODEL) {
      console.error('summary 429, retrying with', SUM_ALT);
      return textGen(body, deadline, null, SUM_ALT);
    }
    throw e;
  }
}

// free web search through Tavily (1000 free credits a month, no card); the results are then summarised by Gemini without the paid google_search tool
async function webSearch(query, deadline) {
  const r = await http('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY_KEY },
    body: JSON.stringify({ query: String(query).slice(0, 300), search_depth: 'basic', max_results: 5, include_answer: true })
  }, 10000, deadline);
  if (!r.ok) throw new Error('tavily ' + r.status + ' ' + (await r.text()).slice(0, 150));
  const j = await r.json();
  const items = (j.results || []).slice(0, 5).map((x, i) => (i + 1) + '. ' + String(x.title || '').slice(0, 120) + ': ' + String(x.content || '').slice(0, 500)).join('\n');
  if (!items && !j.answer) throw new Error('tavily no results');
  return (j.answer ? 'סיכום: ' + j.answer + '\n' : '') + items;
}

// free web search with no account and no key: Google News RSS + Hebrew Wikipedia + DuckDuckGo HTML (best effort), summarised by Gemini
const ent = t => String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; zygy-voice/1.0)', 'Accept-Language': 'he,en;q=0.8' };
async function getText(url, deadline, ms) {
  const r = await http(url, { headers: UA }, ms || 6000, deadline);
  if (!r.ok) throw new Error(r.status + ' ' + url.slice(8, 40));
  return r.text();
}
async function newsSearch(q, deadline) {
  const x = await getText('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=he&gl=IL&ceid=IL:he', deadline);
  const items = x.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.slice(0, 6).map(it => {
    const t = ent((/<title>([\s\S]*?)<\/title>/.exec(it) || [])[1]);
    const d = ent((/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it) || [])[1]).slice(0, 16);
    return t ? '- ' + t + (d ? ' (' + d + ')' : '') : '';
  }).filter(Boolean).join('\n');
}
async function wikiSearch(q, deadline) {
  const x = await getText('https://he.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(q) +
    '&gsrlimit=2&prop=extracts&exintro=1&explaintext=1&exchars=500&format=json&origin=*', deadline);
  const pages = Object.values((JSON.parse(x).query || {}).pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map(p => p.extract ? '- ' + p.title + ': ' + String(p.extract).replace(/\s+/g, ' ').slice(0, 500) : '').filter(Boolean).join('\n');
}
async function ddgSearch(q, deadline) {
  const x = await getText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=il-he', deadline);
  const titles = [...x.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ent(m[1]));
  const snips = [...x.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ent(m[1]));
  return titles.slice(0, 5).map((t, i) => '- ' + t + (snips[i] ? ': ' + snips[i].slice(0, 300) : '')).join('\n');
}
async function freeSearch(query, deadline) {
  const q = String(query).slice(0, 200);
  const rs = await Promise.allSettled([newsSearch(q, deadline), wikiSearch(q, deadline), ddgSearch(q, deadline)]);
  const part = (name, r) => (r.status === 'fulfilled' && r.value ? name + ':\n' + r.value : '');
  const out = [part('כותרות חדשות', rs[0]), part('ויקיפדיה', rs[1]), part('תוצאות מהאינטרנט', rs[2])].filter(Boolean).join('\n\n');
  if (!out) throw new Error('free search no results: ' + rs.map(r => (r.status === 'rejected' ? r.reason.message : 'empty')).join(' | '));
  return out;
}

const partsText = a => {
  const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
};
const clean = t => String(t || '').replace(/\[\d+(?:,\s*\d+)*\]/g, '').replace(/[*#_`~>|]/g, ' ').replace(/\s+/g, ' ').trim();
function parseJ(t) {
  t = String(t).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* ignore */ } }
  return null;
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const NEW_TTS = /^gemini-(3\.[8-9]|[4-9])/.test(TTS_MODEL);
const voiceName = g => (g === 'female' ? VOICE_FEMALE : VOICE_MALE);
const vcfg = name => (NEW_TTS
  ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }]
  : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }]);
let vIdx = 0;

// other TTS models used automatically when the main one is over quota (each model has its own quota)
const TTS_ALTS = (process.env.TTS_FALLBACK_MODELS || 'gemini-3.8-flash-lite-tts,gemini-2.5-flash-preview-tts').split(',').map(x => x.trim()).filter(Boolean);
async function tts(text, deadline, gender) {
  let last = new Error('no audio from tts');
  for (const m of [TTS_MODEL, ...TTS_ALTS.filter(x => x !== TTS_MODEL)]) {
    try { return await ttsOne(m, text, deadline, gender); }
    catch (e) {
      last = e;
      if (isBudget(e)) throw e;
      if (e.status === 429 || e.status === 404) { console.error('tts', m, 'failed', e.status, '- trying next model'); continue; }
      throw e;
    }
  }
  throw last;
}

async function ttsOne(model, text, deadline, gender) {
  const name = voiceName(gender || DEFAULT_VOICE);
  const isNew = /^gemini-(3\.[8-9]|[4-9])/.test(model);
  const cfgs = isNew ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }] : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }];
  let vi = model === TTS_MODEL ? vIdx : 0;
  let last = new Error('no audio from tts');
  for (let i = 0; i < 3; i++) {
    try {
      const t = await gem(model, {
        contents: [{ role: 'user', parts: [{ text: text.slice(0, 800) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: cfgs[vi] } }
      }, deadline, 'tts');
      const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (part) {
        let pcm = Buffer.from(part.inlineData.data, 'base64');
        if (pcm.subarray(0, 4).toString() !== 'RIFF') {
          const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
          pcm = wav(pcm, m ? Number(m[1]) : 24000);
        }
        return pcm;
      }
      last = new Error('no audio from tts');
    } catch (e) {
      last = e;
      if (isBudget(e)) throw e;
      if (e.status === 429 || e.status === 404) throw e;
      if (e.status === 400 && /voice|speech/i.test(e.message) && vi < 1) { vi++; if (model === TTS_MODEL) vIdx = vi; }
    }
  }
  throw last;
}

// ---------- Yemot files ----------
async function download(name, deadline, d) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(yp(name, d)), {}, 8000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error('download failed ' + last);
}

async function upload(name, buf, deadline, d) {
  const path = yp(name, d);
  // documented form first (token and path in the URL, file in the body), then the all-in-body form
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', path); f.append('convertAudio', '1');
      }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('upload failed ' + last);
}

// cleanup is best effort and never blocks or fails a call
function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

// ---------- per-call state and the recording turn ----------
const idOf = q => String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
const phoneOf = q => { const p = String(q.ApiPhone || '').replace(/\D/g, ''); return p.length >= 7 ? p : ''; };
const newCid = () => Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

async function mkState(q, d, sys, g, stage) {
  const s = {
    d, sys, g, n: 0, h: [], p: '', name: '', r: '', t: Date.now(),
    e: crypto.randomBytes(3).toString('hex'),
    phone: phoneOf(q), v: DEFAULT_VOICE, cid: newCid(), stage: stage || 'chat', idle: 0, sel: ''
  };
  if (s.phone) {
    const u = await getUser(s.phone);
    if (u.v === 'female' || u.v === 'male') s.v = u.v;
  }
  return s;
}

// every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
// (s.e keeps the names unique even if this server restarted in the middle of a call)
function ask(s, pre) {
  s.n++;
  s.p = 'Q' + s.e + s.n;
  s.name = 'q' + s.e + 'n' + s.n;
  return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
}

// one recording turn: download -> Gemini (answer / voice / search) -> optional web search -> TTS -> upload -> play
async function chat(q, s, T0) {
  if (!q[s.p]) return ask(s, 't-' + AGAIN);
  const deadline = T0 + BUDGET;
  const qn = s.name;
  try {
    const audio = await download(qn, deadline, s.d);
    del(qn, s.d);
    if (s.r) { del(s.r, s.d); s.r = ''; }
    const t1 = Date.now();
    const hist = s.h.slice(-16);

    const a = await textGen({
      systemInstruction: { parts: [{ text: s.sys + ROUTER }] },
      contents: [...hist, { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }] }]
    }, deadline, { responseMimeType: 'application/json' });
    const raw = partsText(a);
    if (!raw) throw new Error('empty answer ' + JSON.stringify((a.promptFeedback || {})).slice(0, 100));

    const j = parseJ(raw);
    let qText = '', text = '', wantSearch = false, sq = '';
    if (j && typeof j === 'object') {
      qText = String(j.q || '').trim();
      text = clean(j.a);
      wantSearch = j.search === true || j.search === 'true';
      sq = String(j.sq || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (j.voice === 'female' || j.voice === 'male') s.v = j.voice;
    } else {
      text = clean(raw); // the model ignored the JSON format: speak its text as is
    }

    let searched = false;
    if (wantSearch && qText) {
      searched = true;
      let stage = 'google', info = '';
      try {
        let sa = null;
        if (GOOGLE_SEARCH) {
          try {
            const gdl = Math.min(deadline, Date.now() + 15000);
            sa = await textGen({
              systemInstruction: { parts: [{ text: s.sys + SEARCH_NOTE }] },
              contents: [...hist, { role: 'user', parts: [{ text: qText }] }],
              tools: [{ google_search: {} }]
            }, gdl, null, SEARCH_MODEL || undefined);
            if (!partsText(sa)) sa = null;
          } catch (e) {
            if (isBudget(e) && deadline - Date.now() < 3000) throw e;
            console.error('google search failed, using free search:', e.message);
            sa = null;
          }
        }
        if (!sa) {
          stage = 'results';
          info = TAVILY_KEY ? await webSearch(sq || qText, deadline) : await freeSearch(sq || qText, deadline);
          stage = 'summary';
          sa = await sumGen({
            systemInstruction: { parts: [{ text: s.sys + ' להלן תוצאות חיפוש מהאינטרנט. ענה רק על סמך התוצאות, בעברית, בעד ' + SEARCH_W + ' מילים, בלי כתובות אתרים ובלי סימנים מיוחדים. אם התוצאות לא עונות על השאלה, אמור זאת בקצרה. השיחה רציפה ושאלות המשך מתייחסות לתשובות הקודמות.' }] },
            contents: [...hist, { role: 'user', parts: [{ text: 'שאלה: ' + qText + '\n\nתוצאות חיפוש:\n' + info }] }]
          }, deadline);
        }
        text = clean(partsText(sa)) || 'לא מצאתי תשובה באינטרנט';
      } catch (e) {
        if (isBudget(e)) throw e;
        console.error('search failed at', stage, e.message);
        // if only the summary step failed, read the first search results aloud as they are
        const raw = info.split('\n').filter(l => /^(- |\d+\.\s)/.test(l)).slice(0, 3).map(l => l.replace(/^(- |\d+\.\s)/, '')).join('. ');
        text = stage === 'summary' && clean(raw) ? clean(raw).slice(0, 400) : 'החיפוש באינטרנט לא זמין כרגע';
      }
    }
    if (!text) throw new Error('empty text');
    const t2 = Date.now();

    const pcm = await tts(text, deadline, s.v);
    const t3 = Date.now();

    const rn = 'r' + s.e + 'n' + s.n;
    await upload(rn, pcm, deadline, s.d);
    s.r = rn;
    s.h.push({ role: 'user', parts: [{ text: qText || '[שאלה קולית]' }] }, { role: 'model', parts: [{ text }] });
    if (s.h.length > 20) s.h = s.h.slice(-20);
    saveTurn(s, qText, text).catch(e => console.error('save turn', e.message));

    console.log('turn', s.n, 'ok', searched ? 'search' : '', s.v, 'gemini', t2 - t1, 'ms tts', t3 - t2, 'ms total', Date.now() - T0, 'ms');
    return ask(s, 'f-' + s.d + '/' + rn);
  } catch (e) {
    console.error('turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message, e.stderr ? '| ' + String(e.stderr).replace(/\s+/g, ' ') : '');
    del(qn, s.d);
    return ask(s, 't-' + ERR);
  }
}

// the opening message can be a recording made by Gemini; it is played when the file greet.wav exists in the extension
const greetOk = {};
async function greetFile(d, deadline) {
  if (greetOk[d] !== undefined) return greetOk[d];
  try {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + d), {}, 3500, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') return false;
    greetOk[d] = JSON.stringify(j).includes('greet.wav');
    return greetOk[d];
  } catch (e) {
    return false;
  }
}

// main extension: a new conversation on every call
app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = idOf(q);
  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r, old.d);
      delete calls[id];
      return res.send('noop=bye');
    }
    const s = calls[id] || (calls[id] = await mkState(q, ext.d, ext.sys, ext.g));
    s.t = Date.now();
    if (!s.name) {
      const g = (await greetFile(s.d, Date.now() + 4000)) ? 'f-' + s.d + '/greet' : 't-' + s.g;
      return res.send(ask(s, g));
    }
    return res.send(await chat(q, s, T0));
  } catch (e) {
    // last resort: always answer Yemot with plain text, never HTML or an empty reply
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// ---------- history extension (default extension 4): choose a saved conversation, hear it, continue it ----------
// keypad prompt; if your Yemot account expects another read format, change only this function
function askKey(s, pre) {
  s.n++;
  s.p = 'H' + s.e + s.n;
  return 'read=' + pre + '=' + s.p + ',no,tap,1,1,7,No,No,No';
}

function startChat(s, cid, h) {
  s.stage = 'chat'; s.cid = cid; s.h = h; s.name = '';
  return ask(s, 't-' + REC_HINT);
}

function menu(s, u) {
  let c = u.c.find(x => x.id === s.sel);
  if (s.stage !== 'list' && !c) s.stage = 'list';
  if (s.stage === 'list') {
    if (!u.c.length) return startChat(s, newCid(), []);
    const items = u.c.map((x, i) => 'שיחה ' + (i + 1) + ' ' + spx(x.title)).join(' ');
    return askKey(s, 't-' + sp('שיחות אחרונות ' + items + ' לשיחה חדשה הקישו 9'));
  }
  if (s.stage === 'conv') {
    const l = c.turns[c.turns.length - 1] || { q: '', a: '' };
    return askKey(s, 't-' + sp('השאלה האחרונה בשיחה ' + spx(l.q).slice(0, 200) + ' והתשובה ' + spx(l.a).slice(0, 300) +
      ' להמשך השיחה הקישו 1 להאזנה לכל השיחה הקישו 2 לחזרה לרשימה הקישו 3'));
  }
  let txt = '';
  for (let i = c.turns.length - 1; i >= 0; i--) {
    const part = 'שאלה ' + spx(c.turns[i].q).slice(0, 200) + ' תשובה ' + spx(c.turns[i].a).slice(0, 300) + ' ';
    if ((part + txt).length > 1500) break;
    txt = part + txt;
  }
  return askKey(s, 't-' + sp(txt + ' להמשך השיחה הקישו 1 לחזרה לרשימה הקישו 3'));
}

function onKey(s, u, key) {
  if (s.stage === 'list') {
    if (key === '9') return startChat(s, newCid(), []);
    const c = /^[1-8]$/.test(key) ? u.c[Number(key) - 1] : null;
    if (c) { s.sel = c.id; s.stage = 'conv'; }
    return menu(s, u);
  }
  const c = u.c.find(x => x.id === s.sel);
  if (!c) { s.stage = 'list'; return menu(s, u); }
  if (key === '1') return startChat(s, c.id, histOf(c.turns));
  if (key === '3') { s.stage = 'list'; return menu(s, u); }
  if (key === '2' && s.stage === 'conv') s.stage = 'full';
  return menu(s, u);
}

app.all('/history', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = 'H' + idOf(q);
  res.type('text/plain');
  const T0 = Date.now();
  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r, old.d);
      delete calls[id];
      return res.send('noop=bye');
    }
    const s = calls[id] || (calls[id] = await mkState(q, HIST_DIR, EXT_FIRST.sys, EXT_FIRST.g, 'list'));
    s.t = Date.now();
    if (!s.phone) {
      return res.send('id_list_message=t-' + sp('לא ניתן לזהות את מספר הטלפון ולכן אין היסטוריית שיחות') + '&go_to_folder=hangup');
    }
    if (s.stage === 'chat') return res.send(await chat(q, s, T0));

    const u = await getUser(s.phone);
    if (!s.p) return res.send(menu(s, u));
    const key = String(q[s.p] || '').trim();
    if (!key) {
      if (++s.idle >= 3) return res.send('go_to_folder=hangup');
      return res.send(menu(s, u));
    }
    s.idle = 0;
    return res.send(onKey(s, u, key));
  } catch (e) {
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// ---------- tools ----------
// asks Gemini to read the given text aloud and stores it as a file in the given extension
// dir is an extension number such as 5 or 5/2, or empty for the main menu of the line; file is the name without .wav
// optional voice field: male or female
let lastRec = 0;
app.post('/record', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  try {
    if (String(req.body.token || '') !== TOKEN) return res.send('ERR הטוקן לא תואם לטוקן ששמור בשירות');
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
    const pcm = await tts(text, deadline, req.body.voice === 'female' ? 'female' : req.body.voice === 'male' ? 'male' : DEFAULT_VOICE);
    await upload(file, pcm, deadline, d);
    if (file === 'greet') greetOk[d] = true;
    res.send('OK ההקלטה נוצרה על ידי ג׳מיני והועלתה אל ' + (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') + ' בשם ' + file + '.wav (' + Math.round(pcm.length / 1024) + 'KB)');
  } catch (e) {
    res.send('ERR ' + String(e.message).slice(0, 200));
  }
});

// quick end to end check of the whole chain, without a phone call
let lastTest = 0;
app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastTest < 20000) return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  lastTest = Date.now();
  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try { out.push('OK  ' + name + (await fn() || '')); }
    catch (e) { out.push('ERR ' + name + ': ' + String(e.message).slice(0, 220)); }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות ג׳מיני לתמלול', async () => { if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק'); return ' (' + KEYS.length + ')'; });
  await step('מפתחות ג׳מיני להקראה', async () => { if (!TTS_KEYS.length) throw new Error('GEMINI_TTS_KEYS ריק'); return ' (' + TTS_KEYS.length + ')'; });
  await step('טוקן ימות', async () => { if (!TOKEN || /undefined/.test(TOKEN)) throw new Error('YEMOT_TOKEN ריק'); });
  await step('ימות: קריאת השלוחה ' + EXT, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + EXTP), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp('selftest')), {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
  });
  await step('ג׳מיני ' + TEXT_MODEL + ' (קלט אודיו)', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: silent.toString('base64') } }, { text: 'ענה במילה אחת' }] }] }, deadline);
    if (!(((a.candidates || [])[0] || {}).content)) throw new Error('תשובה ריקה');
    return ' (thinking: ' + (THINK[thinkIdx] || 'ברירת מחדל') + ')';
  });
  await step('חיפוש חינמי ' + (TAVILY_KEY ? '(Tavily)' : '(ללא מפתח)'), async () => {
    const info = TAVILY_KEY ? await webSearch('חדשות היום בישראל', deadline) : await freeSearch('חדשות היום בישראל', deadline);
    return ' (' + info.length + ' תווים)';
  });
  await step('ג׳מיני ' + (SEARCH_MODEL || TEXT_MODEL) + ' (חיפוש גוגל' + (GOOGLE_SEARCH ? ', פעיל' : ', כבוי: GOOGLE_SEARCH לא 1') + ')', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ text: 'מה התאריך היום? ענה במילים ספורות' }] }], tools: [{ google_search: {} }] }, deadline, null, SEARCH_MODEL || undefined);
    if (!partsText(a)) throw new Error('תשובה ריקה');
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול גברי)', async () => {
    const p = await tts('בדיקה', deadline, 'male');
    return ' (' + VOICE_MALE + ', ' + Math.round(p.length / 1024) + 'KB)';
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול נשי)', async () => {
    const p = await tts('בדיקה', deadline, 'female');
    return ' (' + VOICE_FEMALE + ', ' + Math.round(p.length / 1024) + 'KB)';
  });
  await step('אחסון היסטוריית שיחות (' + (UP_URL && UP_TOK ? 'Upstash' : 'קבצים') + ')', async () => {
    const raw = String(Date.now());
    if (UP_URL && UP_TOK) {
      await upstash(['SET', 'zygy:selftest', raw, 'EX', '60']);
      if ((await upstash(['GET', 'zygy:selftest'])) !== raw) throw new Error('הקריאה לא תואמת לכתיבה');
      return '';
    }
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const f = path.join(DATA_DIR, 'selftest.tmp');
    await fs.promises.writeFile(f, raw);
    await fs.promises.unlink(f);
    return ' (אזהרה: ב-Render החינמי הקבצים נמחקים בכל הפעלה מחדש, מומלץ להגדיר Upstash)';
  });
  res.send(out.join('\n'));
});

app.use((err, req, res, next) => {
  console.error('express', err && err.message);
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + ERR);
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));

app.listen(process.env.PORT || 3000, () => console.log('zygy up v4 search=' + (GOOGLE_SEARCH ? 'google+free' : TAVILY_KEY ? 'tavily' : 'free')));
