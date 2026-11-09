const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '200kb' }));

// CORS for the installer page: admin API (protected by login token) and self test
app.use(['/admin/api', '/selftest'], (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- settings
// Everything is configured from the admin page (/admin) and stored in the history store.
// Environment variables with the same meaning still work as defaults (see ENVMAP).
const env = process.env;
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_GREET = 'שלום אנא הקלט את ההודעה בסיום הקש סולמית';
const DEFAULTS = {
  groqKeys: '', geminiKeys: '', ttsKeys: '', yemotToken: '',
  voice: 'Kore', greeting: DEFAULT_GREET, waitMsg: 'אנא המתן', searchMsg: 'מחפש', maxWords: 400, extra: '',
  searchMode: 'on-request', searchDomains: '', searchExclude: '', searchRegex: '',
  extPaths: '1', histPath: '2', historyBack: 'hangup', historyMaxConvs: 9, historyTtlDays: 60,
  chatModel: 'openai/gpt-oss-120b', groqModel: 'groq/compound', sttModel: 'whisper-large-v3',
  textModel: 'gemini-3.6-flash', ttsModel: 'gemini-3.8-flash-tts',
  turnBudgetMs: 55000, recMax: 30, ttsParallel: 3
};
const SECRET = ['groqKeys', 'geminiKeys', 'ttsKeys', 'yemotToken'];
const ENVMAP = {
  groqKeys: 'GROQ_API_KEYS', geminiKeys: 'GEMINI_API_KEYS', ttsKeys: 'GEMINI_TTS_KEYS', yemotToken: 'YEMOT_TOKEN',
  voice: 'VOICE', greeting: 'GREETING', waitMsg: 'WAIT_MSG', searchMsg: 'SEARCH_MSG', maxWords: 'MAX_WORDS', extra: 'EXTRA_INSTRUCTION',
  searchMode: 'SEARCH_MODE', searchDomains: 'SEARCH_DOMAINS', searchExclude: 'SEARCH_EXCLUDE', searchRegex: 'SEARCH_REGEX',
  extPaths: 'EXT_PATH', histPath: 'HIST_PATH', historyBack: 'HISTORY_BACK', historyMaxConvs: 'HISTORY_MAX_CONVS', historyTtlDays: 'HISTORY_TTL_DAYS',
  chatModel: 'CHAT_MODEL', groqModel: 'GROQ_MODEL', sttModel: 'STT_MODEL', textModel: 'TEXT_MODEL', ttsModel: 'TTS_MODEL',
  turnBudgetMs: 'TURN_BUDGET_MS', recMax: 'REC_MAX', ttsParallel: 'TTS_PARALLEL'
};
const ENV_S = {};
for (const k of Object.keys(ENVMAP)) { const v = env[ENVMAP[k]]; if (v !== undefined && (v !== '' || k === 'greeting' || k === 'waitMsg' || k === 'searchMsg')) ENV_S[k] = v; }
if (!ENV_S.yemotToken && env.YEMOT_API_USERNAME) ENV_S.yemotToken = env.YEMOT_API_USERNAME + ':' + env.YEMOT_API_PASSWORD;
let STORED = {};
let S = { ...DEFAULTS, ...ENV_S };

const YM = env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const GROQ_BASE = env.GROQ_BASE || 'https://api.groq.com/openai/v1';
const UP_URL = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = env.UPSTASH_REDIS_REST_TOKEN || '';
const MAX_TURNS = parseInt(env.HISTORY_MAX_TURNS, 10) || 30;
const PLAY_CHARS = parseInt(env.HISTORY_PLAY_CHARS, 10) || 2200;

// derived values, recomputed by applySettings() every time the settings change (no restart needed)
let KEYS = [], TTS_KEYS = [], GROQ_KEYS = [], TOKEN = '';
let TEXT_MODEL, TTS_MODEL, GROQ_MODEL, CHAT_MODEL, STT_MODEL, VOICE;
let SEARCH_MODE, SEARCH_RE, SEARCH_DOMAINS = [], SEARCH_EXCLUDE = [];
let BUDGET, REC_MAX, TTS_PAR, MAXW, EXTRA, MAX_CONVS, TTL, HIST_BACK;
let EXTS = {}, EXT_FIRST, EXT, EXTP;

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();
const sp2 = s => sp(s).replace(/[()\[\]{}:;!?\/\\*#_~<>]/g, ' ').replace(/\s+/g, ' ').trim();
const T = s => 't-' + sp(s);
const VOICE_LIST = {
  male: ['Puck', 'Charon', 'Fenrir', 'Orus', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieban', 'Algenib', 'Rasalgethi', 'Alnilam', 'Schedar', 'Achird', 'Zubenelgenubi', 'Sadachbia', 'Sadaltager'],
  female: ['Kore', 'Zephyr', 'Leda', 'Aoede', 'Callirrhoe', 'Autonoe', 'Despina', 'Erinome', 'Laomedeia', 'Achernar', 'Gacrux', 'Pulcherrima', 'Vindemiatrix', 'Sulafat']
};
const ALL_VOICES = [...VOICE_LIST.male, ...VOICE_LIST.female];
const okVoice = v => ALL_VOICES.find(x => x.toLowerCase() === String(v || '').trim().toLowerCase()) || '';

const today = () => new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'full' });
const buildSys = (extra, searching) => 'אתה עוזר קולי חכם בטלפון, ברמה של העוזרים המתקדמים ביותר. ' +
  ' הקלט שלך הוא תמלול אוטומטי של דיבור ועלול להכיל טעויות, הבן את הכוונה. ענה בעברית אלא אם ביקשו שפה אחרת. ' +
  'ענה בפירוט רב ובצורה מקיפה ומעמיקה, כמו תשובה יסודית של עוזר מתקדם: הסבר, תן הקשר, דוגמאות ופרטים רלוונטיים, בסדר הגיוני ובשפה זורמת. ' +
  'התאם את האורך לשאלה, שאלה פשוטה תקבל תשובה קצרה יחסית ושאלה מורכבת תשובה ארוכה, עד כ ' + MAXW + ' מילים. ' +
  'התשובה מושמעת בקול בטלפון, לכן כתוב טקסט רציף בלבד: בלי רשימות, בלי כותרות, בלי כוכביות וסימנים מיוחדים, בלי טבלאות, בלי קישורים וכתובות אתרים ובלי אימוג׳י. ' +
  (searching
    ? 'המשתמש ביקש חיפוש באינטרנט: חפש ברשת וענה לפי מה שמצאת. אפשר לציין את שם האתר במילים אבל לא להקריא כתובות. '
    : 'אין לך גישה לאינטרנט בתשובה הזאת. אם השאלה דורשת מידע עדכני שאינך יודע, אמור זאת בקצרה ואמור שאפשר לבקש ממך לחפש באינטרנט. ') +
  'שינוי קול: אם המשתמש מבקש לשנות את הקול (גבר, אישה, עמוק, צעיר, חם וכדומה) הוסף בתחילת התשובה תג בצורה [[VOICE:שם]] כשהשם אחד מאלה. גברים: ' + VOICE_LIST.male.join(' ') + '. נשים: ' + VOICE_LIST.female.join(' ') + '. לחזרה לקול ברירת המחדל כתוב [[VOICE:default]]. ' +
  'שינוי סגנון הקראה: אם המשתמש מבקש לדבר לאט, מהר, בשמחה, ברצינות, בלחש וכדומה הוסף תג [[STYLE:הנחיה קצרה באנגלית]] למשל [[STYLE:slowly and calmly]], ולביטול [[STYLE:none]]. אחרי התג אשר בקצרה את השינוי ובצע אותו. אל תכתוב תגים כאלה אם לא ביקשו שינוי. ' +
  'התאריך היום: ' + today() + '. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '');

function applySettings() {
  S = { ...DEFAULTS, ...ENV_S, ...STORED };
  const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
  KEYS = keyList(S.geminiKeys); TTS_KEYS = keyList(S.ttsKeys); GROQ_KEYS = keyList(S.groqKeys);
  TOKEN = String(S.yemotToken || '').trim();
  TEXT_MODEL = S.textModel; TTS_MODEL = S.ttsModel; GROQ_MODEL = S.groqModel; CHAT_MODEL = S.chatModel; STT_MODEL = S.sttModel;
  VOICE = okVoice(S.voice) || 'Kore';
  SEARCH_MODE = ['on-request', 'always', 'off'].includes(S.searchMode) ? S.searchMode : 'on-request';
  try { SEARCH_RE = new RegExp(S.searchRegex || 'באינטרנט|ברשת|בגוגל|אונליין|חפש|תחפש|חפשי|חיפוש'); }
  catch (e) { SEARCH_RE = /באינטרנט|ברשת|בגוגל|אונליין|חפש|תחפש|חפשי|חיפוש/; }
  SEARCH_DOMAINS = keyList(S.searchDomains); SEARCH_EXCLUDE = keyList(S.searchExclude);
  BUDGET = num(S.turnBudgetMs, 55000, 10000, 120000);
  REC_MAX = String(num(S.recMax, 30, 5, 120));
  TTS_PAR = num(S.ttsParallel, 3, 1, 6);
  MAXW = num(S.maxWords, 400, 30, 1200);
  EXTRA = String(S.extra || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  MAX_CONVS = num(S.historyMaxConvs, 9, 1, 9);
  TTL = num(S.historyTtlDays, 60, 0, 3650) * 86400;
  HIST_BACK = String(S.historyBack || 'hangup').trim() || 'hangup';
  EXTS = {};
  for (let p of keyList(S.extPaths)) {
    p = p.replace(/^\/+|\/+$/g, '');
    if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
    EXTS[p.replace(/\//g, '_')] = { p, d: '/' + p, extra: EXTRA, dom: SEARCH_DOMAINS, g: sp(String(S.greeting == null ? '' : S.greeting).slice(0, 300)) };
  }
  EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: '1', d: '/1', extra: EXTRA, dom: SEARCH_DOMAINS, g: sp(String(S.greeting || '')) };
  EXT = EXT_FIRST.p; EXTP = '/' + EXT;
}
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + '.wav';
applySettings();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => e && /budget/.test(e.message || '');
const rot = { text: 0, tts: 0, groq: 0 };
const calls = {};
const hcalls = {};

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
  for (const id of Object.keys(hcalls)) if (now - hcalls[id].t > 3600000) delete hcalls[id];
}, 600000).unref();

// ---------------------------------------------------------------- storage for conversation history
const DATA = env.DATA_DIR || path.join(__dirname, 'data');
const mem = new Map();
try { const o = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8')); for (const k of Object.keys(o)) mem.set(k, o[k]); } catch (e) {}
let saveT;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'store.json'), JSON.stringify(Object.fromEntries(mem))); } catch (e) {} }, 500); };
async function up(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(6000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('history store ' + (j.error || r.status));
  return j.result;
}
async function kvGet(k) {
  if (UP_URL) { const v = await up(['GET', k]); return v ? JSON.parse(v) : null; }
  return mem.has(k) ? JSON.parse(mem.get(k)) : null;
}
async function kvSet(k, v) {
  if (UP_URL) { const c = ['SET', k, JSON.stringify(v)]; if (TTL) c.push('EX', TTL); await up(c); return; }
  mem.set(k, JSON.stringify(v)); persist();
}
async function kvDel(k) { if (UP_URL) await up(['DEL', k]); else { mem.delete(k); persist(); } }

const IDX = ph => 'zi:' + ph;
const CK = (ph, id) => 'zc:' + ph + ':' + id;
const listConvs = async ph => (await kvGet(IDX(ph))) || [];
const getConv = (ph, id) => kvGet(CK(ph, id));
const titleOf = q => sp2(q).split(' ').slice(0, 6).join(' ') || 'שיחה';

async function saveTurn(ph, cid, q, a) {
  const now = Date.now();
  let conv = await kvGet(CK(ph, cid));
  if (!conv) conv = { id: cid, t: now, title: titleOf(q), turns: [] };
  conv.turns.push({ q, a, t: now });
  if (conv.turns.length > MAX_TURNS) conv.turns = conv.turns.slice(-MAX_TURNS);
  conv.u = now;
  await kvSet(CK(ph, cid), conv);
  let idx = ((await kvGet(IDX(ph))) || []).filter(x => x.id !== cid);
  idx.unshift({ id: cid, title: conv.title, u: now, n: conv.turns.length });
  const drop = idx.splice(MAX_CONVS);
  await kvSet(IDX(ph), idx);
  for (const d of drop) kvDel(CK(ph, d.id)).catch(() => {});
}
async function deleteConv(ph, id) {
  const idx = ((await kvGet(IDX(ph))) || []).filter(x => x.id !== id);
  await kvSet(IDX(ph), idx);
  await kvDel(CK(ph, id));
}
async function deleteAll(ph) {
  for (const c of await listConvs(ph)) await kvDel(CK(ph, c.id)).catch(() => {});
  await kvDel(IDX(ph));
}

// ---------------------------------------------------------------- http helpers
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
    await sleep(500);
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

async function groq(path, build, ms, deadline) {
  if (!GROQ_KEYS.length) throw new Error('GROQ_API_KEYS is empty');
  let err = 'groq ' + path + ' failed';
  let status = 0;
  for (let i = 0; i < GROQ_KEYS.length * 2; i++) {
    const key = GROQ_KEYS[rot.groq++ % GROQ_KEYS.length];
    try {
      const r = await http(GROQ_BASE + path, build(key), ms, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = 'groq ' + path + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = 'groq ' + path + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    await sleep(500);
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// ---------------------------------------------------------------- speech to text, answers
const THINK = ['minimal', 'low', null];
let thinkIdx = 0;
async function textGen(body, deadline, maxTok) {
  for (;;) {
    const lvl = THINK[thinkIdx];
    const gc = { maxOutputTokens: maxTok || 1024 };
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
    try {
      return await gem(TEXT_MODEL, { ...body, generationConfig: gc }, deadline, 'text');
    } catch (e) {
      if (e.status === 400 && /think/i.test(e.message) && thinkIdx < THINK.length - 1) { thinkIdx++; continue; }
      throw e;
    }
  }
}
const gemText = a => ((((a.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();

async function transcribeGroq(audio, deadline) {
  const j = await groq('/audio/transcriptions', key => {
    const f = new FormData();
    f.append('file', new Blob([audio], { type: 'audio/wav' }), 'a.wav');
    f.append('model', STT_MODEL); f.append('language', 'he'); f.append('temperature', '0'); f.append('response_format', 'json');
    return { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: f };
  }, 20000, deadline);
  return String(j.text || '').trim();
}
async function transcribeGemini(audio, deadline) {
  const a = await textGen({ contents: [{ role: 'user', parts: [
    { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
    { text: 'תמלל במדויק את הדיבור בהקלטה. החזר רק את התמלול עצמו. אם אין דיבור ברור החזר טקסט ריק.' }] }] }, deadline, 512);
  return gemText(a);
}

async function answerGroq(sys, hist, q, dom, deadline, search) {
  const model = search ? GROQ_MODEL : CHAT_MODEL;
  const body = {
    model, temperature: 0.6, max_completion_tokens: 2500,
    messages: [{ role: 'system', content: sys }, ...hist.map(m => ({ role: m.r, content: m.c })), { role: 'user', content: q }]
  };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  if (search && /compound/.test(model)) {
    const ss = {};
    if (dom.length) ss.include_domains = dom;
    if (SEARCH_EXCLUDE.length) ss.exclude_domains = SEARCH_EXCLUDE;
    if (Object.keys(ss).length) body.search_settings = ss;
  }
  const j = await groq('/chat/completions', key => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body)
  }), 45000, deadline);
  return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
}
async function answerGemini(sys, hist, q, deadline) {
  const a = await textGen({
    systemInstruction: { parts: [{ text: sys }] },
    contents: [...hist.map(m => ({ role: m.r === 'user' ? 'user' : 'model', parts: [{ text: m.c }] })), { role: 'user', parts: [{ text: q }] }]
  }, deadline, 4096);
  return gemText(a);
}

// the answer is read aloud: remove markdown, links, citations, emoji
function speak(s) {
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\d+(?:\s*[,\-]\s*\d+)*\]/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*#_`~>|]+/g, ' ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?:])(\s*\.)+/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- read aloud (long answers are cut into pieces and read in parallel)
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function pcmOf(b) {
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === 'data') return { rate: b.readUInt32LE(24), pcm: b.subarray(o + 8, Math.min(b.length, o + 8 + sz)) };
    o += 8 + sz + (sz % 2);
  }
  return { rate: 24000, pcm: b.subarray(44) };
}
function joinWav(list) {
  const ps = list.map(pcmOf);
  const rate = ps[0].rate;
  const gap = Buffer.alloc(Math.round(rate * 0.2) * 2);
  const out = [];
  ps.forEach((p, i) => { if (i) out.push(gap); out.push(p.pcm); });
  return wav(Buffer.concat(out), rate);
}
function chunks(text, max) {
  const sents = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let s of sents) {
    while (s.length > max) {
      let k = s.lastIndexOf(' ', max);
      if (k < max / 2) k = max;
      if ((cur + s.slice(0, k)).length > max) flush();
      cur += s.slice(0, k) + ' '; flush();
      s = s.slice(k).trimStart();
    }
    if ((cur + s).length > max) flush();
    cur += s;
  }
  flush();
  return out;
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const newTts = () => /^gemini-(3\.[8-9]|[4-9])/.test(TTS_MODEL);
const voicesFor = v => newTts()
  ? [{ voice: v }, { prebuiltVoiceConfig: { voiceName: v } }]
  : [{ prebuiltVoiceConfig: { voiceName: v } }, { voice: v }];
let vIdx = 0;

async function tts(text, deadline, voice, style) {
  const VOICES = voicesFor(okVoice(voice) || VOICE);
  const prompt = style ? 'Say ' + style + ': ' + text : text;
  let last = new Error('no audio from tts');
  for (let i = 0; i < 3; i++) {
    try {
      const t = await gem(TTS_MODEL, {
        contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 1300) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: VOICES[vIdx] } }
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
      if (e.status === 400 && /voice|speech/i.test(e.message) && vIdx < VOICES.length - 1) vIdx++;
    }
  }
  throw last;
}
async function ttsLong(text, deadline, voice, style) {
  const parts = chunks(text, 450);
  if (parts.length <= 1) return tts(parts[0] || text, deadline, voice, style);
  const res = new Array(parts.length);
  let next = 0;
  const worker = async () => { while (next < parts.length) { const i = next++; res[i] = await tts(parts[i], deadline, voice, style); } };
  await Promise.all(Array.from({ length: Math.min(TTS_PAR, parts.length) }, worker));
  return joinWav(res);
}

// ---------------------------------------------------------------- Yemot file helpers
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
      const r = await http(url, { method: 'POST', body: f }, 20000, deadline);
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

function del(name, d) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name, d)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}
function endCall(id) {
  const old = calls[id];
  if (old && old.r) del(old.r, old.d);
  delete calls[id]; delete hcalls[id];
}
const newCall = (ext, o) => ({ d: ext.d, ext, g: ext.g, n: 0, h: [], p: '', name: '', r: '', t: Date.now(), e: crypto.randomBytes(3).toString('hex'), cid: '', cont: false, ...(o || {}) });
const digits = v => String(v || '').replace(/[^0-9]/g, '');

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

// ---------------------------------------------------------------- the conversation extension
app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
  res.type('text/plain');
  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;
  try {
    if (q.hangup === 'yes') { endCall(id); return res.send('noop=bye'); }

    const ph = digits(q.ApiPhone);
    const s = calls[id] || (calls[id] = newCall(ext));
    s.t = Date.now();

    // every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
    const ask = pre => {
      s.n++;
      s.p = 'Q' + s.e + s.n;
      s.name = 'q' + s.e + 'n' + s.n;
      return 'read=' + pre + '=' + s.p + ',no,record,' + s.d + ',' + s.name + ',no,,,1,' + REC_MAX;
    };

    if (!s.name) {
      let pre = '';
      if (s.g) pre = 't-' + s.g;
      return res.send(ask(pre));
    }
    if (!q[s.p]) return res.send(ask('t-' + AGAIN));

    // phase B: the wait message was played, now wait for the answer prepared in the background
    if (s.job) {
      // answer not ready yet -> keep playing the wait message again, until the answer is ready
      const r = await Promise.race([s.job.then(v => ({ v })), sleep(1200)]);
      if (r && r.v !== undefined) { s.job = null; s.w = 0; return res.send(r.v); }
      s.w = (s.w || 0) + 1;
      return res.send('read=t-' + s.wm + '=W' + s.e + s.n + 'x' + s.w + ',no,tap,1,0,1,No,no,no');
    }

    // phase A: recording arrived. Download and transcribe, then prepare the answer in the background
    const deadline = T0 + BUDGET;
    const qn = s.name;
    let question = '', search = false;
    try {
      const audio = await download(qn, deadline, s.d);
      del(qn, s.d);
      if (s.r) { del(s.r, s.d); s.r = ''; }
      if (GROQ_KEYS.length) {
        try { question = await transcribeGroq(audio, deadline); }
        catch (e) { if (isBudget(e)) throw e; console.error(id, 'groq stt failed:', e.message); question = await transcribeGemini(audio, deadline); }
      } else question = await transcribeGemini(audio, deadline);
      question = question.replace(/\s+/g, ' ').trim();
      if (question.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return res.send(ask('t-' + AGAIN));
      if (ph && !s.prefLoaded) {
        s.prefLoaded = true;
        try { const pr = await kvGet('zp:' + ph); if (pr) { s.voice = pr.voice || ''; s.style = pr.style || ''; } } catch (e) {}
      }
      // web search only when asked by voice ("search the web"), unless SEARCH_MODE says otherwise
      search = !!(GROQ_KEYS.length && SEARCH_MODE !== 'off' && (SEARCH_MODE === 'always' || SEARCH_RE.test(question)));
    } catch (e) {
      console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message);
      del(qn, s.d);
      return res.send(ask('t-' + ERR));
    }

    const job = (async () => {
      try {
        const t2 = Date.now();
        const sys = buildSys(s.ext.extra, search);
        const hist = s.h.slice(-12);
        let raw = '';
        if (GROQ_KEYS.length) {
          try { raw = await answerGroq(sys, hist, question, s.ext.dom, deadline, search); }
          catch (e) { if (isBudget(e)) throw e; console.error(id, 'groq answer failed:', e.message); }
        }
        if (!raw) raw = await answerGemini(sys, hist, question, deadline);
        let changed = false;
        raw = raw.replace(/\[\[\s*(VOICE|STYLE)\s*:\s*([^\]]*?)\s*\]\]/gi, (m, k, v) => {
          if (/^voice$/i.test(k)) { s.voice = /^(default|none)$/i.test(v) ? '' : (okVoice(v) || s.voice || ''); }
          else { s.style = /^(default|none)$/i.test(v) ? '' : v.replace(/[^\w ,\-]/g, '').slice(0, 80); }
          changed = true; return ' ';
        });
        if (changed && ph) kvSet('zp:' + ph, { voice: s.voice || '', style: s.style || '' }).catch(() => {});
        const text = speak(raw);
        if (!text) throw new Error('empty answer');
        const t3 = Date.now();
        const pcm = await ttsLong(text, deadline, s.voice, s.style);
        const t4 = Date.now();
        const rn = 'r' + s.e + 'n' + s.n;
        await upload(rn, pcm, deadline, s.d);
        s.r = rn;
        s.h.push({ r: 'user', c: question }, { r: 'assistant', c: text });
        if (s.h.length > 16) s.h = s.h.slice(-16);
        if (ph) {
          if (!s.cid) s.cid = crypto.randomBytes(4).toString('hex');
          saveTurn(ph, s.cid, question, text).catch(e => console.error(id, 'history save failed:', e.message));
        }
        console.log(id, 'turn', s.n, 'ok', search ? 'search' : 'chat', 'answer', t3 - t2, 'ms tts', t4 - t3, 'ms total', Date.now() - T0, 'ms', 'chars', text.length);
        return ask('f-' + s.d + '/' + rn);
      } catch (e) {
        console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message);
        return ask('t-' + ERR);
      }
    })();

    // say "searching" / "please wait" while the answer is prepared (empty text = no message, answer directly)
    const wm = sp(search ? S.searchMsg : S.waitMsg);
    if (!wm) return res.send(await job);
    s.job = job; s.wm = wm; s.w = 0;
    return res.send('read=t-' + wm + '=W' + s.e + s.n + ',no,tap,1,0,1,No,no,no');
  } catch (e) {
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// ---------------------------------------------------------------- the history extension
// Yemot: set the history extension to type api and point it at  /hist   (or /hist/5_2 to continue into extension 5/2)
const tapRead = (msg, p) => 'read=' + msg + '=' + p + ',no,tap,1,1,10,No,no,no';
const M = (...a) => a.filter(Boolean).join('.');
function tparts(text, max) {
  const out = [];
  for (const sent of String(text).split(/[.!?\n]+/)) {
    let w = sp2(sent);
    while (w.length > max) {
      let k = w.lastIndexOf(' ', max);
      if (k < max / 2) k = max;
      out.push('t-' + w.slice(0, k).trim()); w = w.slice(k).trim();
    }
    if (w) out.push('t-' + w);
  }
  return out;
}
const listMenu = convs => M(T(convs.length === 1 ? 'יש לך שיחה אחרונה אחת' : 'יש לך ' + convs.length + ' שיחות אחרונות'),
  ...convs.map((c, i) => T('לשיחה על ' + sp2(c.title) + ' הקש ' + (i + 1))), T('למחיקת כל השיחות הקש 0'));
const convMenu = c => M(T('שיחה על ' + sp2(c.title)), T('לשמיעת השיחה הקש 1 להמשך השיחה הקש 2 למחיקת השיחה הקש 3 לחזרה לרשימה הקש 9'));
function playParts(conv) {
  let turns = conv.turns.slice(-3);
  const len = ts => ts.reduce((n, t) => n + t.q.length + t.a.length, 0);
  while (turns.length > 1 && len(turns) > PLAY_CHARS) turns = turns.slice(1);
  const omitted = turns.length < conv.turns.length;
  const out = omitted ? [T('מושמעות השאלות האחרונות')] : [];
  for (const t of turns) out.push(T('שאלה'), ...tparts(t.q, 250), T('תשובה'), ...tparts(t.a.slice(0, PLAY_CHARS), 250));
  return out;
}

app.all(['/hist', '/hist/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
  res.type('text/plain');
  try {
    if (q.hangup === 'yes') { endCall(id); return res.send('noop=bye'); }
    const ph = digits(q.ApiPhone);
    const target = EXTS[String(req.params.e || '')] || EXT_FIRST;
    const finish = text => 'id_list_message=' + T(text) + '&go_to_folder=' + HIST_BACK;
    if (!ph) return res.send(finish('לא ניתן להציג היסטוריה כי מספר הטלפון חסוי'));

    const h = hcalls[id] || (hcalls[id] = { n: 0, p: '', step: '', msg: '', sel: null, convs: [], e: crypto.randomBytes(3).toString('hex') });
    h.t = Date.now();
    const show = (msg, step) => { h.n++; h.p = 'H' + h.e + h.n; h.step = step; h.msg = msg; return tapRead(msg, h.p); };
    const showList = async pre => {
      h.convs = await listConvs(ph);
      if (!h.convs.length) return finish((pre ? 'השיחה נמחקה ' : '') + 'אין שיחות אחרונות');
      return show(M(pre ? T(pre) : '', listMenu(h.convs)), 'list');
    };

    if (!h.p) return res.send(await showList(''));
    const ans = digits(q[h.p]).slice(0, 1);
    if (!ans) return res.send(show(h.msg, h.step));

    if (h.step === 'list') {
      if (ans === '0') return res.send(show(T('למחיקת כל השיחות הקש 1 לביטול הקש 2'), 'delall'));
      const c = h.convs[Number(ans) - 1];
      if (!c) return res.send(show(h.msg, 'list'));
      h.sel = c;
      return res.send(show(convMenu(c), 'conv'));
    }
    if (h.step === 'delall') {
      if (ans === '1') { await deleteAll(ph); return res.send(finish('כל השיחות נמחקו')); }
      return res.send(await showList(''));
    }
    if (h.step === 'conv') {
      if (ans === '1') {
        const conv = await getConv(ph, h.sel.id);
        if (!conv) return res.send(await showList(''));
        return res.send(show(M(...playParts(conv), T('לשמיעה חוזרת הקש 1 להמשך השיחה הקש 2 למחיקת השיחה הקש 3 לחזרה לרשימה הקש 9')), 'conv'));
      }
      if (ans === '2') {
        const conv = await getConv(ph, h.sel.id);
        if (!conv) return res.send(await showList(''));
        const old = calls[id];
        if (old && old.r) del(old.r, old.d);
        calls[id] = newCall(target, {
          cid: conv.id, cont: true, g: sp('אפשר להמשיך לשאול'),
          h: conv.turns.slice(-6).flatMap(t => [{ r: 'user', c: t.q }, { r: 'assistant', c: t.a }])
        });
        delete hcalls[id];
        return res.send('go_to_folder=' + target.d);
      }
      if (ans === '3') { await deleteConv(ph, h.sel.id); return res.send(await showList('השיחה נמחקה')); }
      if (ans === '9') return res.send(await showList(''));
      return res.send(show(h.msg, 'conv'));
    }
    return res.send(await showList(''));
  } catch (e) {
    console.error(id, 'history fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR + '&go_to_folder=' + HIST_BACK);
  }
});

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
    const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!text) return res.send('ERR הטקסט ריק');
    lastRec = Date.now();
    const d = dir ? '/' + dir : '';
    const deadline = Date.now() + 80000;
    const pcm = await ttsLong(text, deadline);
    await upload(file, pcm, deadline, d);
    res.send('OK ההקלטה נוצרה והועלתה אל ' + (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') + ' בשם ' + file + '.wav (' + Math.round(pcm.length / 1024) + 'KB)');
  } catch (e) {
    res.send('ERR ' + String(e.message).slice(0, 200));
  }
});

// ---------------------------------------------------------------- self test
let lastTest = 0;
async function runTests() {
  if (Date.now() - lastTest < 15000) return 'ERR נבדק הרגע, חכו 15 שניות ונסו שוב';
  lastTest = Date.now();
  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try { out.push('OK  ' + name + (await fn() || '')); }
    catch (e) { out.push('ERR ' + name + ': ' + String(e.message).slice(0, 220)); }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות Groq', async () => { if (!GROQ_KEYS.length) throw new Error('לא הוזן מפתח Groq, החיפוש והתמלול לא יעבדו'); return ' (' + GROQ_KEYS.length + ')'; });
  await step('מפתחות ג׳מיני להקראה', async () => { if (!TTS_KEYS.length) throw new Error('לא הוזן מפתח הקראה'); return ' (' + TTS_KEYS.length + ')'; });
  await step('טוקן ימות', async () => { if (!TOKEN || /undefined/.test(TOKEN)) throw new Error('לא הוזן טוקן ימות'); });
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
  await step('Groq ' + GROQ_MODEL + ' עם חיפוש באינטרנט', async () => {
    const t = await answerGroq('ענה בקצרה בעברית.', [], 'מה התאריך היום ומה מזג האוויר בתל אביב', SEARCH_DOMAINS, deadline, true);
    if (!t) throw new Error('תשובה ריקה');
    return ' (' + t.slice(0, 80).replace(/\s+/g, ' ') + ')';
  });
  await step('Groq ' + CHAT_MODEL + ' (בלי חיפוש)', async () => {
    const t = await answerGroq('ענה במילה אחת בעברית.', [], 'מה צבע השמיים', [], deadline, false);
    if (!t) throw new Error('תשובה ריקה');
  });
  await step('Groq ' + STT_MODEL + ' (תמלול)', async () => { await transcribeGroq(silent, deadline); });
  await step('אחסון היסטוריה: ' + (UP_URL ? 'Upstash' : 'קובץ מקומי (יימחק בפריסה מחדש)'), async () => {
    await kvSet('zt:test', { ok: 1 });
    const v = await kvGet('zt:test'); await kvDel('zt:test');
    if (!v || v.ok !== 1) throw new Error('קריאה אחרי כתיבה נכשלה');
  });
  if (KEYS.length) await step('ג׳מיני ' + TEXT_MODEL + ' (גיבוי)', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ text: 'ענה במילה אחת: שלום' }] }] }, deadline);
    if (!gemText(a)) throw new Error('תשובה ריקה');
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול)', async () => {
    const p = await ttsLong('בדיקה. זאת בדיקה של הקראה ארוכה יותר, כדי לוודא שהחיבור בין החלקים עובד.', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });
  return out.join('\n');
}
app.get('/selftest', async (req, res) => { res.type('text/plain; charset=utf-8').send(await runTests()); });

// ---------------------------------------------------------------- admin page: connect everything without touching Render settings
const sessions = new Map();
const fails = {};
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const mask = v => { const l = keyList(v); return l.length ? l.length + ' ' + (l.length === 1 ? 'ערך' : 'ערכים') + ' שמורים, מסתיים ב ' + l[l.length - 1].slice(-4) : ''; };
async function loadSettings() {
  try { STORED = (await kvGet('zconf')) || {}; } catch (e) { console.error('settings load failed:', e.message); STORED = {}; }
  applySettings();
}
const baseUrl = req => (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0] + '://' + req.headers.host;

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store').type('html');
  try { res.send(fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8')); } catch (e) { res.status(500).send('admin.html not found'); }
});
app.get('/admin/api/state', async (req, res) => {
  let hasPw = !!env.ADMIN_PASSWORD;
  if (!hasPw) { try { hasPw = !!(await kvGet('zauth')); } catch (e) {} }
  res.json({ setup: !hasPw, storage: UP_URL ? 'upstash' : 'file' });
});
app.post('/admin/api/setup', async (req, res) => {
  try {
    if (env.ADMIN_PASSWORD || await kvGet('zauth')) return res.status(403).json({ error: 'כבר הוגדרה סיסמה' });
    const pw = String((req.body || {}).password || '');
    if (pw.length < 6) return res.status(400).json({ error: 'הסיסמה צריכה להיות לפחות 6 תווים' });
    const salt = crypto.randomBytes(12).toString('hex');
    await kvSet('zauth', { salt, hash: hashPw(pw, salt) });
    res.json({ ok: 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/api/login', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const f = fails[ip] || (fails[ip] = { n: 0, t: Date.now() });
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 8) return res.status(429).json({ error: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' });
  try {
    const pw = String((req.body || {}).password || '');
    let ok = false;
    if (env.ADMIN_PASSWORD) ok = pw === env.ADMIN_PASSWORD;
    else { const a = await kvGet('zauth'); ok = !!a && crypto.timingSafeEqual(Buffer.from(hashPw(pw, a.salt)), Buffer.from(a.hash)); }
    if (!ok) { f.n++; await sleep(800); return res.status(401).json({ error: 'סיסמה שגויה' }); }
    const tok = crypto.randomBytes(24).toString('hex');
    sessions.set(tok, Date.now() + 12 * 3600000);
    res.json({ token: tok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const guard = (req, res, next) => {
  const t = req.headers['x-admin-token'];
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'נדרשת התחברות' });
  next();
};
app.get('/admin/api/config', guard, (req, res) => {
  const out = { ...S }, secrets = {};
  for (const k of SECRET) { delete out[k]; secrets[k] = mask(S[k]); }
  res.json({
    config: out, secrets, storage: UP_URL ? 'upstash' : 'file',
    voices: VOICE_LIST, urls: { base: baseUrl(req) }
  });
});
app.post('/admin/api/config', guard, async (req, res) => {
  try {
    const b = req.body || {};
    const next = { ...STORED };
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in b)) continue;
      let v = b[k];
      if (SECRET.includes(k)) { v = String(v || '').trim(); if (!v) continue; }
      else if (typeof DEFAULTS[k] === 'number') v = Number(v);
      else v = String(v == null ? '' : v);
      next[k] = v;
    }
    for (const k of (Array.isArray(b._clear) ? b._clear : [])) if (SECRET.includes(k)) delete next[k];
    await kvSet('zconf', next);
    STORED = next; applySettings();
    res.json({ ok: 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/api/test', guard, async (req, res) => { res.json({ result: await runTests() }); });
// experimental: ask Yemot to point the two extensions at this server
app.post('/admin/api/yemot-setup', guard, async (req, res) => {
  const out = [];
  const base = baseUrl(req);
  const jobs = [];
  for (const e of Object.values(EXTS)) jobs.push(['שלוחת שיחה ' + e.p, e.d, base + '/yemot/' + e.p.replace(/\//g, '_')]);
  const hp = String(S.histPath || '').replace(/^\/+|\/+$/g, '');
  if (/^[0-9]+(\/[0-9]+)*$/.test(hp)) jobs.push(['שלוחת היסטוריה ' + hp, '/' + hp, base + '/hist' + (EXT_FIRST.p.includes('/') ? '/' + EXT_FIRST.p.replace(/\//g, '_') : '')]);
  for (const [name, d, url] of jobs) {
    try {
      const r = await fetch(YM + 'UpdateExtension?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + d) + '&type=api&api_wait_answer_music_on_hold=yes&api_link=' + encodeURIComponent(url), { signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      out.push((j.responseStatus === 'OK' ? 'OK  ' : 'ERR ') + name + ' -> ' + url + (j.responseStatus === 'OK' ? '' : ' ' + JSON.stringify(j).slice(0, 160)));
    } catch (e) { out.push('ERR ' + name + ': ' + e.message); }
  }
  res.json({ result: out.join('\n') });
});

app.use((err, req, res, next) => {
  console.error('express', err && err.message);
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + ERR);
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));

if (require.main === module || process.env.VOICE_AI_RUN) {
  loadSettings().finally(() => app.listen(process.env.PORT || 3000, () => {
    console.log('voice-ai up | settings:', Object.keys(STORED).length ? 'loaded from admin page' : 'defaults', '| storage:', UP_URL ? 'upstash' : 'local file (lost on redeploy)', '| admin: /admin');
  }));
}
