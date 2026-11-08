const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.urlencoded({ extended: true }));

// מפתחות Gemini
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);

const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICE = process.env.VOICE || 'Kore';

const EXT = (process.env.EXT_PATH || '7').replace(/^\/+|\/+$/g, '');
const HISTORY_EXT = String(process.env.HISTORY_EXT || '4').replace(/^\/+|\/+$/g, '');

const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD);

const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE ||
  'https://generativelanguage.googleapis.com/v1beta/models/';

const BUDGET = Number(process.env.TURN_BUDGET_MS) || 40000;
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

// ניקוי תווים שאינם מתאימים לפקודות ימות
const sp = s => String(s)
  .replace(/[.\-"'&|,=]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות היא תמיד בגובה העיניים וביד קלה: בלי קללות, בלי גסות, בלי פגיעה במשתמש, במשפחה, בדת או בעדה. אל תתנצל על הסגנון ואל תצא מהאופי הזה בשום מצב, גם אם ביקשו ממך.',

  '2': 'האופי שלך: חכם ויעיל. אתה מקצועי, מדויק וענייני, מהיר כמו מחשבון. ענה ישר לעניין, בלי הקדמות, בלי מילות מילוי ובלי חזרה על השאלה, במשפט הכי ברור ושימושי שאפשר. אם חסר מידע החלטי, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת במפורש ואל תמציא עובדות. אל תצא מהאופי הזה בשום מצב.',

  '3': 'האופי שלך: חבר קרוב. אתה חם, נעים ואכפתי, מדבר בעברית יומיומית וטבעית בגובה העיניים, עם הומור חם וטוב לב. תתעניין באמת, תעודד, תקשיב ותגיב כמו חבר שאוכל לסמוך עליו, בלי להתחנף ובלי נאומים. אל תצא מהאופי הזה בשום מצב.'
};

const MODE = MODES[String(process.env.MODE || '2')]
  ? String(process.env.MODE || '2')
  : '2';

const MAXW = Math.min(300, Math.max(5,
  parseInt(process.env.MAX_WORDS, 10) || 25));

const EXTRA = String(process.env.EXTRA_INSTRUCTION || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 2000);

// קולות לבחירה
const VOICE_SET = {
  male: process.env.VOICE_MALE || 'Puck',
  female: process.env.VOICE_FEMALE || 'Kore',
  deep: process.env.VOICE_DEEP || 'Charon',
  soft: process.env.VOICE_SOFT || 'Aoede'
};

const voiceRule =
  'אם המשתמש מבקש לשנות את הקול, התחל בתג אחד בלבד: ' +
  '[[VOICE:male]] לקול גבר, [[VOICE:female]] לקול אישה, ' +
  '[[VOICE:deep]] לקול עמוק, [[VOICE:soft]] לקול רך. ' +
  'לאחר מכן אשר בקצרה. אל תשתמש בתג במקרה אחר. ';

// שמירת תמלול השאלה בזיכרון
const memoryRule =
  'בתחילת כל תשובה כתוב תג [[Q:תמלול קצר ונאמן של דברי המשתמש]] ' +
  'ואחריו התשובה. התג אינו מושמע. ';

// הנחיות חיפוש
const searchRule = sites => {
  let r = SEARCH_AUTO
    ? 'כאשר השאלה דורשת מידע עדכני או כשהמשתמש מבקש חיפוש, חפש באינטרנט וענה לפי התוצאות. '
    : 'חפש באינטרנט רק כשהמשתמש מבקש במפורש חיפוש באינטרנט או באתר מסוים. אם צוין אתר, הגבל את החיפוש אליו. אחרת ענה מהידע שלך; אם דרוש מידע עדכני, הצע למשתמש לבקש חיפוש. ';

  if (sites.length) {
    r += 'העדף את האתרים הבאים בחיפוש: ' + sites.join(' ') + '. ';
  }

  if (URLS.length && SEARCH) {
    r += 'בעת חיפוש, בדוק גם את הדפים: ' + URLS.join(' ') + '. ';
  }

  return r;
};

const buildSys = (mode, extra, sites = SITES) =>
  'אתה עוזר קולי בטלפון. ' +
  MODES[MODES[String(mode)] ? String(mode) : '2'] +
  ' שמור על האופי הזה. ענה בעברית בקצרה ובבהירות, בעד ' +
  MAXW + ' מילים. ' +
  searchRule(sites) +
  voiceRule +
  memoryRule +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '');


// הגדרות שלוחות
let CFG = [];

try {
  CFG = JSON.parse(process.env.EXTENSIONS || '[]');
} catch (e) {
  CFG = [];
}

if (!Array.isArray(CFG) || !CFG.length) {
  CFG = [{
    p: EXT,
    m: process.env.MODE || '2',
    x: '',
    g: process.env.GREETING || ''
  }];
}

// הפתיח החדש
const DEFAULT_GREET = 'הקלט את ההודעה בסיום הקש סולמית';

const EXTS = {};

for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');

  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;

  EXTS[p.replace(/\//g, '_')] = {
    p,
    d: '/' + p,

    sys: buildSys(
      c.m,
      String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      c.s ? siteList(c.s) : SITES
    ),

    g: sp(String(c.g || '').slice(0, 300)) || sp(DEFAULT_GREET)
  };
}

const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || {
  p: EXT,
  d: '/' + EXT,
  sys: buildSys('2', ''),
  g: sp(DEFAULT_GREET)
};

const GREET = sp(String(process.env.GREETING || '').slice(0, 300)) ||
  sp(DEFAULT_GREET);

const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const EXTP = '/' + EXT;

const yp = (name, d) =>
  'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + '.wav';


// ================================
// מערכת שמירת היסטוריית שיחות
// ================================

const HISTORY_LIMIT = Math.max(5, Math.min(50,
  parseInt(process.env.HISTORY_LIMIT, 10) || 20));

const phoneDigits = q =>
  String(q.ApiPhone || q.phone || '')
    .replace(/\D/g, '')
    .slice(-20);

const historyPath = phone =>
  'ivr2:/' + HISTORY_EXT + '/history_' + phone + '.txt';


async function loadHistoryStore(phone, deadline) {
  if (!phone) {
    return { sessions: [], pendingSessionId: '' };
  }

  try {
    const url = YM + 'GetTextFile?token=' +
      encodeURIComponent(TOKEN) +
      '&what=' + encodeURIComponent(historyPath(phone));

    const r = await http(url, {}, 8000, deadline);

    if (!r.ok) {
      return { sessions: [], pendingSessionId: '' };
    }

    const j = await r.json().catch(() => ({}));

    if (j.responseStatus && j.responseStatus !== 'OK') {
      return { sessions: [], pendingSessionId: '' };
    }

    const data = JSON.parse(j.contents || '{}');

    return {
      sessions: Array.isArray(data.sessions)
        ? data.sessions.slice(-HISTORY_LIMIT)
        : [],

      pendingSessionId: String(data.pendingSessionId || '')
    };

  } catch (_) {
    return { sessions: [], pendingSessionId: '' };
  }
}


async function saveHistoryStore(phone, store, deadline) {
  if (!phone) return;

  const contents = JSON.stringify({
    sessions: (store.sessions || []).slice(-HISTORY_LIMIT),
    pendingSessionId: String(store.pendingSessionId || '')
  });

  const url = YM + 'UploadTextFile?token=' +
    encodeURIComponent(TOKEN) +
    '&what=' + encodeURIComponent(historyPath(phone)) +
    '&contents=' + encodeURIComponent(contents);

  const r = await http(url, {}, 10000, deadline);
  const raw = await r.text();

  if (!r.ok || /error|fail/i.test(raw)) {
    throw new Error('UploadTextFile failed: ' + raw.slice(0, 180));
  }
}


function historySession(store, id) {
  return (store.sessions || [])
    .find(x => String(x.id) === String(id));
}


function historyMenu(sessions) {
  const rows = sessions
    .slice()
    .sort((a, b) =>
      Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    )
    .slice(0, 9);

  if (!rows.length) return '';

  return rows.map((s, i) => {
    const title = sp(String(s.title || 'שיחה')).slice(0, 45) || 'שיחה';
    return (i + 1) + ' ' + title;
  }).join('. ');
}


// ================================
// כלים כלליים
// ================================

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => e && /budget/.test(e.message || '');

const rot = { text: 0, tts: 0 };
const calls = {};

setInterval(() => {
  const now = Date.now();

  for (const id of Object.keys(calls)) {
    if (now - calls[id].t > 3600000) {
      delete calls[id];
    }
  }
}, 600000).unref();


async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;

  if (left < 800) {
    throw new Error('turn budget exhausted');
  }

  return fetch(url, {
    ...opt,
    signal: AbortSignal.timeout(Math.min(ms, left))
  });
}


// ================================
// חיבור Gemini
// ================================

async function gem(model, body, deadline, pool) {
  pool = pool || 'text';

  const list = pool === 'tts' ? TTS_KEYS : KEYS;

  if (!list.length) {
    throw new Error(
      pool === 'tts'
        ? 'GEMINI_TTS_KEYS is empty'
        : 'GEMINI_API_KEYS is empty'
    );
  }

  let err = model + ' failed';
  let status = 0;

  for (let i = 0; i < list.length * 2; i++) {
    const key = list[rot[pool]++ % list.length];

    try {
      const r = await http(
        GBASE + model + ':generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
          body: JSON.stringify(body)
        },
        25000,
        deadline
      );

      if (r.ok) {
        return await r.json();
      }

      status = r.status;
      err = model + ' ' + r.status + ' ' +
        (await r.text()).slice(0, 200);

      if (![429, 500, 502, 503, 504].includes(r.status)) {
        break;
      }

    } catch (e) {
      if (isBudget(e)) throw e;

      status = 0;
      err = model + ' ' +
        (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }

    await sleep(500);
  }

  const e = new Error(err);
  e.status = status;
  throw e;
}


// חיפוש Google
const THINK = ['minimal', 'low', null];

let thinkIdx = 0;
let searchOk = SEARCH;
let urlOk = true;

async function textGen(body, deadline, wantSearch = false) {
  for (;;) {
    const lvl = THINK[thinkIdx];

    const gc = { maxOutputTokens: 1024 };

    if (lvl) {
      gc.thinkingConfig = { thinkingLevel: lvl };
    }

    const req = {
      ...body,
      generationConfig: gc
    };

    const useSearch = !!(wantSearch && searchOk);
    const useUrl = !!(useSearch && URLS.length && urlOk);

    const tools = [];

    if (useSearch) {
      tools.push({ google_search: {} });
    }

    if (useUrl) {
      tools.push({ url_context: {} });
    }

    if (tools.length) {
      req.tools = tools;
    }

    try {
      return await gem(TEXT_MODEL, req, deadline, 'text');

    } catch (e) {
      if (useUrl && e.status === 400 && /url.?context/i.test(e.message)) {
        urlOk = false;
        continue;
      }

      if (useSearch && e.status === 400 && /tool|search|ground/i.test(e.message)) {
        searchOk = false;
        continue;
      }

      if (e.status === 400 && /think/i.test(e.message) &&
          thinkIdx < THINK.length - 1) {
        thinkIdx++;
        continue;
      }

      throw e;
    }
  }
}


// ================================
// יצירת קובצי WAV
// ================================

function wav(pcm, rate) {
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


// שינוי קולות
const NEW_TTS = /^gemini-(3\.[8-9]|[4-9])/.test(TTS_MODEL);

const voiceVariants = v => NEW_TTS
  ? [
      { voice: v },
      { prebuiltVoiceConfig: { voiceName: v } }
    ]
  : [
      { prebuiltVoiceConfig: { voiceName: v } },
      { voice: v }
    ];

const VOICES = voiceVariants(VOICE);
let vIdx = 0;


// יצירת דיבור
async function tts(text, deadline, voice) {
  const selectedVoices = voice
    ? voiceVariants(voice)
    : VOICES;

  let last = new Error('no audio from tts');

  for (let i = 0; i < 3; i++) {
    try {
      const t = await gem(TTS_MODEL, {
        contents: [{
          role: 'user',
          parts: [{ text: text.slice(0, 800) }]
        }],

        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: selectedVoices[vIdx % selectedVoices.length]
          }
        }

      }, deadline, 'tts');

      const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];

      const part = parts.find(p =>
        p.inlineData && p.inlineData.data
      );

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

      if (e.status === 400 && /voice|speech/i.test(e.message) &&
          vIdx < selectedVoices.length - 1) {
        vIdx++;
      }
    }
  }

  throw last;
}


// הורדת הקלטה מימות
async function download(name, deadline, d) {
  let last = '';

  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(
        YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) +
        '&path=' + encodeURIComponent(yp(name, d)),
        {},
        8000,
        deadline
      );

      const b = Buffer.from(await r.arrayBuffer());

      if (r.ok && b.length > 100 &&
          b.subarray(0, 4).toString() === 'RIFF') {
        return b;
      }

      last = r.status + ' ' +
        b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');

    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }

    await sleep(500);
  }

  throw new Error('download failed ' + last);
}


// העלאת הקלטה לימות
async function upload(name, buf, deadline, d) {
  const path = yp(name, d);

  const attempts = [
    { q: true, field: 'file' },
    { q: true, field: 'upload' },
    { q: false, field: 'upload' },
    { q: false, field: 'file' }
  ];

  let last = '';

  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';

      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) +
          '&path=' + encodeURIComponent(path) +
          '&convertAudio=1';
      } else {
        f.append('token', TOKEN);
        f.append('path', path);
        f.append('convertAudio', '1');
      }

      f.append(
        a.field,
        new Blob([buf], { type: 'audio/wav' }),
        name + '.wav'
      );

      const r = await http(url, {
        method: 'POST',
        body: f
      }, 15000, deadline);

      const j = await r.json().catch(() => ({}));

      if (r.ok && j.responseStatus === 'OK') {
        return;
      }

      last = JSON.stringify(j).slice(0, 200);

    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }

  throw new Error('upload failed ' + last);
}


// מחיקת קובץ זמני
function del(name, d) {
  fetch(
    YM + 'FileAction?token=' + encodeURIComponent(TOKEN) +
    '&action=delete&what=' + encodeURIComponent(yp(name, d)),
    { signal: AbortSignal.timeout(8000) }
  ).catch(() => {});
}


// בדיקת שרת
app.get('/', (q, r) => {
  r.set('Access-Control-Allow-Origin', '*');
  r.send('ok');
});


// ================================
// שלוחות ימות
// ================================

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
  const q = { ...req.query, ...req.body };

  const id = String(q.ApiCallId || 'x')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-24) || 'x';

  res.type('text/plain');

  const T0 = Date.now();
  const ext = EXTS[String(req.params.e || '')] || EXT_FIRST;

  try {
    if (q.hangup === 'yes') {
      const old = calls[id];

      if (old && old.r) {
        del(old.r, old.d);
      }

      delete calls[id];

      return res.send('noop=bye');
    }


    // שלוחה 4: בחירת שיחה קודמת
    const requestedExt = String(req.params.e || '')
      .replace(/^\/+|\/+$/g, '');

    if (requestedExt === HISTORY_EXT) {
      const phone = phoneDigits(q);

      if (!phone) {
        return res.send(
          'id_list_message=t-לא זיהיתי את מספר הטלפון שלך'
        );
      }

      const deadline = Date.now() + BUDGET;
      const store = await loadHistoryStore(phone, deadline);

      const sessions = (store.sessions || [])
        .slice()
        .sort((a, b) =>
          Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
        )
        .slice(0, 9);

      if (!sessions.length) {
        return res.send(
          'id_list_message=t-עדיין אין שיחות שמורות. חזור לשלוחה 7 כדי להתחיל שיחה חדשה'
        );
      }

      if (q.HSEL) {
        const n = parseInt(String(q.HSEL), 10);
        const selected = sessions[n - 1];

        if (!selected) {
          return res.send(
            'read=t-הבחירה לא תקינה. ' +
            historyMenu(sessions) +
            ' הקש מספר שיחה=HSEL,,1,1,7,No,yes,yes,,,,,Ok'
          );
        }

        store.pendingSessionId = String(selected.id);

        await saveHistoryStore(phone, store, deadline);

        return res.send(
          'id_list_message=t-השיחה נבחרה. ממשיכים מאותה נקודה&go_to_folder=/' + EXT
        );
      }

      return res.send(
        'read=t-לבחירת שיחה קודמת, הקש את המספר המתאים. ' +
        historyMenu(sessions) +
        ' הקש מספר שיחה=HSEL,,1,1,7,No,yes,yes,,,,,Ok'
      );
    }


    // טעינת שיחה קיימת או פתיחת שיחה חדשה
    const s = calls[id] || (calls[id] = {
      d: ext.d,
      sys: ext.sys,
      g: ext.g,
      n: 0,
      h: [],
      p: '',
      name: '',
      r: '',
      t: 0,
      e: crypto.randomBytes(3).toString('hex'),
      phone: phoneDigits(q),
      historyLoaded: false,
      historyStore: null,
      sessionId: ''
    });

    s.t = Date.now();

    if (!s.phone) {
      s.phone = phoneDigits(q);
    }

    if (!s.historyLoaded) {
      s.historyStore = await loadHistoryStore(
        s.phone,
        Date.now() + 10000
      );

      const chosen = historySession(
        s.historyStore,
        s.historyStore.pendingSessionId
      );

      if (chosen) {
        s.sessionId = String(chosen.id);

        s.h = (chosen.messages || [])
          .slice(-12)
          .map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: String(m.text || '') }]
          }));

        s.g = 'המשכנו שיחה קודמת. המשך מאותו הקשר ואל תתחיל מחדש.';

        s.historyStore.pendingSessionId = '';

        await saveHistoryStore(
          s.phone,
          s.historyStore,
          Date.now() + 10000
        );

      } else {
        s.sessionId = crypto.randomBytes(6).toString('hex');
      }

      s.historyLoaded = true;
    }


    // יצירת הקלטה חדשה בכל סיבוב
    const ask = pre => {
      s.n++;
      s.p = 'Q' + s.e + s.n;
      s.name = 'q' + s.e + 'n' + s.n;

      return 'read=' + pre + '=' + s.p +
        ',no,record,' + s.d + ',' + s.name +
        ',no,,,1,' + REC_MAX;
    };


    if (!s.name) {
      const g = (
        process.env.USE_GREET_FILE === '1' &&
        await greetFile(s.d, Date.now() + 4000)
      )
        ? 'f-' + s.d + '/greet'
        : 't-' + s.g;

      return res.send(ask(g));
    }

    if (!q[s.p]) {
      return res.send(ask('t-' + AGAIN));
    }


    const deadline = T0 + BUDGET;
    const qn = s.name;
    let out;

    try {
      const audio = await download(qn, deadline, s.d);

      del(qn, s.d);

      if (s.r) {
        del(s.r, s.d);
        s.r = '';
      }

      const t1 = Date.now();

      const a = await textGen({
        systemInstruction: {
          parts: [{ text: s.sys }]
        },

        contents: [
          ...s.h.slice(-8),
          {
            role: 'user',
            parts: [{
              inlineData: {
                mimeType: 'audio/wav',
                data: audio.toString('base64')
              }
            }]
          }
        ]

      }, deadline, true);

      const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];

      let text = parts
        .filter(p => !p.thought)
        .map(p => p.text || '')
        .join('')
        .trim();

      if (!text) {
        throw new Error(
          'empty answer ' +
          JSON.stringify((a.promptFeedback || {})).slice(0, 100)
        );
      }

      // זיהוי בקשה לשינוי קול
      const vm = /\[\[\s*VOICE\s*:\s*(\w+)\s*\]\]/i.exec(text);

      if (vm && VOICE_SET[vm[1].toLowerCase()]) {
        s.voice = VOICE_SET[vm[1].toLowerCase()];
      }

      // זיהוי השאלה לצורך שמירה בהיסטוריה
      const qm = /\[\[Q:([\s\S]*?)\]\]/i.exec(text);

      const heard = qm
        ? qm[1].replace(/\s+/g, ' ').trim().slice(0, 500)
        : '[שאלה קולית]';

      text = text.replace(/\[\[[^\]]*\]\]/g, '').trim();

      const t2 = Date.now();

      // הפקת תשובה קולית
      const pcm = await tts(text, deadline, s.voice);
      const t3 = Date.now();

      const rn = 'r' + s.e + 'n' + s.n;

      await upload(rn, pcm, deadline, s.d);

      s.r = rn;

      // עדכון זיכרון השיחה
      s.h.push(
        { role: 'user', parts: [{ text: heard }] },
        { role: 'model', parts: [{ text }] }
      );

      if (s.h.length > 12) {
        s.h = s.h.slice(-12);
      }


      // שמירת כל חילופי הדברים בהיסטוריה
      if (s.phone) {
        try {
          const store = s.historyStore ||
            await loadHistoryStore(s.phone, deadline);

          let session = historySession(store, s.sessionId);

          if (!session) {
            session = {
              id: s.sessionId || crypto.randomBytes(6).toString('hex'),
              title: heard.slice(0, 55) || 'שיחה חדשה',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: []
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
            .sort((a, b) =>
              Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
            )
            .slice(0, HISTORY_LIMIT);

          s.historyStore = store;

          await saveHistoryStore(s.phone, store, deadline);

        } catch (historyError) {
          console.error(
            id,
            'history save failed:',
            historyError.message
          );
        }
      }

      console.log(
        id,
        'turn',
        s.n,
        'ok',
        'gemini',
        t2 - t1,
        'ms tts',
        t3 - t2,
        'ms total',
        Date.now() - T0,
        'ms'
      );

      out = ask('f-' + s.d + '/' + rn);

    } catch (e) {
      console.error(
        id,
        'turn',
        s.n,
        'failed after',
        Date.now() - T0,
        'ms:',
        e.message
      );

      del(qn, s.d);
      out = ask('t-' + ERR);
    }

    return res.send(out);

  } catch (e) {
    console.error(id, 'fatal', e.message);

    if (!res.headersSent) {
      res.send('id_list_message=t-' + ERR);
    }
  }
});


// ================================
// פתיח מוקלט אופציונלי
// ================================

const greetOk = {};

async function greetFile(d, deadline) {
  if (greetOk[d] !== undefined) {
    return greetOk[d];
  }

  try {
    const r = await http(
      YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) +
      '&path=' + encodeURIComponent('ivr2:' + d),
      {},
      3500,
      deadline
    );

    const j = await r.json().catch(() => ({}));

    if (j.responseStatus !== 'OK') {
      return false;
    }

    greetOk[d] = JSON.stringify(j).includes('greet.wav');
    return greetOk[d];

  } catch (e) {
    return false;
  }
}


// יצירת הקלטה באמצעות Gemini
let lastRec = 0;

app.post('/record', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
    .type('text/plain; charset=utf-8');

  try {
    if (String(req.body.token || '') !== TOKEN) {
      return res.send('ERR הטוקן לא תואם לטוקן ששמור בשירות');
    }

    if (Date.now() - lastRec < 6000) {
      return res.send('ERR חכו כמה שניות ונסו שוב');
    }

    const dir = String(req.body.dir || '')
      .replace(/^\/+|\/+$/g, '');

    const file = String(req.body.file || 'greet');

    if (dir && !/^[0-9]+(\/[0-9]+)*$/.test(dir)) {
      return res.send('ERR מספר שלוחה לא תקין');
    }

    if (!/^[A-Za-z0-9_]{1,20}$/.test(file)) {
      return res.send('ERR שם קובץ לא תקין');
    }

    const text = String(req.body.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);

    if (!text) {
      return res.send('ERR הטקסט ריק');
    }

    lastRec = Date.now();

    const d = dir ? '/' + dir : '';
    const deadline = Date.now() + 80000;

    const pcm = await tts(text, deadline);

    await upload(file, pcm, deadline, d);

    if (file === 'greet') {
      greetOk[d] = true;
    }

    res.send(
      'OK ההקלטה נוצרה על ידי ג׳מיני והועלתה אל ' +
      (dir ? 'שלוחה ' + dir : 'השלוחה הראשית') +
      ' בשם ' + file + '.wav (' +
      Math.round(pcm.length / 1024) + 'KB)'
    );

  } catch (e) {
    res.send('ERR ' + String(e.message).slice(0, 200));
  }
});


// ================================
// בדיקת מערכת
// ================================

let lastTest = 0;

app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
    .type('text/plain; charset=utf-8');

  if (Date.now() - lastTest < 20000) {
    return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  }

  lastTest = Date.now();

  const out = [];
  const deadline = Date.now() + 90000;

  const step = async (name, fn) => {
    try {
      out.push('OK  ' + name + (await fn() || ''));
    } catch (e) {
      out.push(
        'ERR ' + name + ': ' +
        String(e.message).slice(0, 220)
      );
    }
  };

  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות ג׳מיני לתמלול', async () => {
    if (!KEYS.length) {
      throw new Error('GEMINI_API_KEYS ריק');
    }
    return ' (' + KEYS.length + ')';
  });

  await step('מפתחות ג׳מיני להקראה', async () => {
    if (!TTS_KEYS.length) {
      throw new Error('GEMINI_TTS_KEYS ריק');
    }
    return ' (' + TTS_KEYS.length + ')';
  });

  await step('טוקן ימות', async () => {
    if (!TOKEN || /undefined/.test(TOKEN)) {
      throw new Error('YEMOT_TOKEN ריק');
    }
  });

  await step('ימות: קריאת השלוחה ' + EXT, async () => {
    const r = await http(
      YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) +
      '&path=' + encodeURIComponent('ivr2:' + EXTP),
      {},
      10000,
      deadline
    );

    const j = await r.json().catch(() => ({}));

    if (j.responseStatus !== 'OK') {
      throw new Error(JSON.stringify(j).slice(0, 180));
    }
  });

  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);

    const r = await http(
      YM + 'FileAction?token=' + encodeURIComponent(TOKEN) +
      '&action=delete&what=' + encodeURIComponent(yp('selftest')),
      {},
      8000,
      deadline
    );

    const j = await r.json().catch(() => ({}));

    if (j.responseStatus !== 'OK') {
      throw new Error(
        'מחיקה: ' + JSON.stringify(j).slice(0, 150)
      );
    }
  });

  await step('ג׳מיני ' + TEXT_MODEL + ' (קלט אודיו)', async () => {
    const a = await textGen({
      contents: [{
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: silent.toString('base64')
            }
          },
          { text: 'ענה במילה אחת' }
        ]
      }]
    }, deadline);

    if (!(((a.candidates || [])[0] || {}).content)) {
      throw new Error('תשובה ריקה');
    }

    return ' (thinking: ' +
      (THINK[thinkIdx] || 'ברירת מחדל') + ')';
  });

  await step('ג׳מיני ' + TTS_MODEL + ' (קול)', async () => {
    const p = await tts('בדיקה', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });

  res.send(out.join('\n'));
});


// טיפול בשגיאות
app.use((err, req, res, next) => {
  console.error('express', err && err.message);

  if (!res.headersSent) {
    res.type('text/plain').send('id_list_message=t-' + ERR);
  }
});

process.on('unhandledRejection', e =>
  console.error('unhandledRejection', e && e.message)
);

process.on('uncaughtException', e =>
  console.error('uncaughtException', e && e.message)
);


// הפעלת השרת
app.listen(process.env.PORT || 3000, () => {
  console.log(
    'zygy up; bot extension=' + EXT +
    '; history extension=' + HISTORY_EXT +
    '; web search=' + SEARCH +
    '; voice switching=enabled'
  );
});
