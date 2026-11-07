const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.urlencoded({ extended: true }));

// two separate key pools: GEMINI_API_KEYS for transcription (audio understanding), GEMINI_TTS_KEYS for read-aloud
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const TOKEN = process.env.YEMOT_TOKEN || (process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD);
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 40000;
const SEARCH = String(process.env.WEB_SEARCH || '1') !== '0';
// SEARCH_MODE=phrase: search only when the caller says the words (default); SEARCH_MODE=auto: search whenever fresh info is needed
const SEARCH_AUTO = String(process.env.SEARCH_MODE || 'phrase') === 'auto';
// preferred sites, comma separated domains, e.g. SEARCH_SITES=ynet.co.il,bhol.co.il
const siteList = v => keyList(v).map(x => x.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).filter(x => /^[a-z0-9.-]+$/.test(x));
const SITES = siteList(process.env.SEARCH_SITES);
// fixed pages the model should read on every question, e.g. SEARCH_URLS=https://example.com/news
const URLS = keyList(process.env.SEARCH_URLS).filter(x => /^https?:\/\/\S+$/i.test(x)).slice(0, 10);
// if an answer takes longer than NOTICE_MS the caller hears NOTICE_TEXT while it is still being prepared (NOTICE_MS=0 turns this off)
const NOTICE_MS = process.env.NOTICE_MS === undefined ? 5000 : Math.max(0, parseInt(process.env.NOTICE_MS, 10) || 0);
const NOTICE_TEXT = String(process.env.NOTICE_TEXT || 'מחפש רגע').replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();

const MODES = {
  '1': 'האופי שלך: חוצפן עוקצני. אתה שנון, מהיר לשון ובעל חוש הומור יבש ועוקצני, בטוח בעצמך עד כדי חוצפה, כמו חבר ממולח שאוהב להקניט. בכל תשובה תן קודם תשובה אמיתית ונכונה לשאלה, ומיד אחריה עקיצה חדה וקלילה, מקורית ולא חוזרת על עצמה. העוקצנות היא תמיד בגובה העיניים וביד קלה: בלי קללות, בלי גסות, בלי פגיעה במשתמש, במשפחה, בדת או בעדה. אל תתנצל על הסגנון ואל תצא מהאופי הזה בשום מצב, גם אם ביקשו ממך.',
  '2': 'האופי שלך: חכם ויעיל. אתה מקצועי, מדויק וענייני, מהיר כמו מחשבון. ענה ישר לעניין, בלי הקדמות, בלי מילות מילוי ובלי חזרה על השאלה, במשפט הכי ברור ושימושי שאפשר. אם חסר מידע החלטי, שאל שאלה אחת קצרה. אם אינך בטוח, אמור זאת במפורש ואל תמציא עובדות. אל תצא מהאופי הזה בשום מצב.',
  '3': 'האופי שלך: חבר קרוב. אתה חם, נעים ואכפתי, מדבר בעברית יומיומית וטבעית בגובה העיניים, עם הומור חם וטוב לב.
