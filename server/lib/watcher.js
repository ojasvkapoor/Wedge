'use strict';
/* The watcher: fetch a page, reduce it to text, fingerprint it, and say what changed.
   Deterministic on purpose — the model is not in this loop. */

const crypto = require('node:crypto');

const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const MAX_BYTES = 1_500_000;

/** Strip a page down to comparable text. */
function extractText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s.replace(/\s+/g, ' ').trim();
}

/** Hash the normalised text so a re-render with a new timestamp is not "news". */
function fingerprint(text) {
  const normal = text
    .toLowerCase()
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')      // clock times churn constantly
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normal).digest('hex').slice(0, 32);
}

/** Pull the numbers out of a line of text, in order, as {raw, value}. */
function numbers(text) {
  const out = [];
  const re = /(?:₹|rs\.?|inr|\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(crore|cr|lakh|lac|million|mn|k)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(v)) continue;
    const u = (m[2] || '').toLowerCase();
    let mult = 1;
    if (u === 'crore' || u === 'cr') mult = 1e7;
    else if (u === 'lakh' || u === 'lac') mult = 1e5;
    else if (u === 'million' || u === 'mn') mult = 1e6;
    else if (u === 'k') mult = 1e3;
    out.push({ raw: m[0].trim(), value: v * mult });
  }
  return out;
}

function money(v) {
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2).replace(/\.00$/, '') + ' crore';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2).replace(/\.00$/, '') + ' lakh';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}

/**
 * Compare two texts and produce one line a human would want to read.
 * Returns null when nothing meaningful moved.
 */
function describeChange(before, after, alarmType) {
  const a = numbers(before);
  const b = numbers(after);
  if (!a.length || !b.length) return { line: 'The page changed.' };

  // a figure that moved, if one did
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].value !== b[i].value) {
      const from = a[i].value;
      const to = b[i].value;
      const pct = from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null;
      const verb = to < from ? 'fell' : 'rose';
      let line = `The figure ${verb} from ${fmtNum(from)} to ${fmtNum(to)}`;
      if (pct !== null) line += ` (${pct > 0 ? '+' : ''}${pct}%)`;
      line += '.';
      return { line, from, to, pct };
    }
  }

  // no number moved: quote what is new
  const beforeWords = new Set(before.toLowerCase().split(' '));
  const added = after
    .split(' ')
    .filter((w) => w.length > 3 && !beforeWords.has(w.toLowerCase()))
    .slice(0, 8)
    .join(' ');
  return { line: added ? `New on the page: ${added}` : 'The page changed.' };
}

function fmtNum(v) {
  if (v >= 1000) return money(v);
  return String(v);
}

/** Fetch a URL politely and return its normalised text. */
async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': process.env.USER_AGENT || 'Wedge/1.0 (+https://your-domain.example/bot)',
        accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/json|xml/i.test(type)) {
      throw new Error('unsupported content type: ' + type.split(';')[0]);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('page too large');
    return extractText(buf.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

/** One check cycle for one alarm. Pure enough to test without a network. */
function evaluate(alarm, previousText, currentText) {
  const hash = fingerprint(currentText);
  if (hash === alarm.lastHash) return { changed: false, hash };
  const change = describeChange(previousText || '', currentText, alarm.type);
  return { changed: true, hash, change, text: currentText };
}

module.exports = { extractText, fingerprint, numbers, describeChange, fetchPage, evaluate, money };
