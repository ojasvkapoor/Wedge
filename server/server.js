'use strict';
/*
  Wedge — server.
  Zero dependencies. Node 20+ (uses global fetch).

    node server.js

  Everything that costs money is behind a guard: alarms are capped by plan,
  and instant alerts are capped per month, because each WhatsApp message is
  a real rupee out of your pocket.
*/

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const plans = require('./lib/plans');
const watcher = require('./lib/watcher');
const wa = require('./lib/whatsapp');
const rzp = require('./lib/razorpay');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');
const TICK_MS = Number(process.env.TICK_MS || 60000);
const DEV = process.env.NODE_ENV !== 'production';

/* ------------------------------------------------------------------ utils */

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS'
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const readJson = async (req) => {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('invalid JSON'); }
};

/* --------------------------------------------------------------- parsing */
/* Same rules as the front end, kept in one place so both agree. */

const TYPES = [
  { t: 'price',    re: /price|₹|rs\.?|cheap|cost|drop|deal|discount/i, freq: 360 },
  { t: 'job',      re: /job|hiring|vacanc|opening|role|position/i,     freq: 180 },
  { t: 'exam',     re: /exam|result|admit|board|neet|jee|cat\b/i,      freq: 360 },
  { t: 'college',  re: /fest|college|admission|campus/i,               freq: 720 },
  { t: 'property', re: /rera|possession|flat|tower|project|approval/i, freq: 720 },
  { t: 'scheme',   re: /scheme|deadline|last date|apply|subsidy/i,     freq: 720 }
];

function parseAlarmText(text) {
  const t = String(text || '').trim();
  if (t.length < 4) throw new Error('say a little more');
  const url = (t.match(/https?:\/\/\S+/i) || [])[0] || null;
  const price = t.match(/(?:below|under|less than|cheaper than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+)/i);
  const hit = TYPES.find((x) => x.re.test(t)) || { t: 'page', freq: 360 };
  const fm = t.match(/every\s+(\d+)\s*(minute|hour|day)/i);
  let freqMinutes = hit.freq;
  if (fm) {
    const n = Number(fm[1]);
    freqMinutes = fm[2].startsWith('min') ? n : fm[2].startsWith('hour') ? n * 60 : n * 1440;
  }
  return {
    type: hit.t,
    what: t.replace(/\s+/g, ' ').slice(0, 160),
    when: price ? `the price goes below ₹${price[1]}` : 'it changes',
    url,
    freqMinutes: Math.max(15, freqMinutes)
  };
}

/* --------------------------------------------------------------- delivery */

async function deliver(user, alarm, change) {
  const sent = store.alertsSentThisMonth(user);
  const channel = alarm.channel || 'email';
  const verdict = plans.canAlert(user, sent, channel);

  if (!verdict.ok) {
    console.log(`[skip] ${alarm.id} — ${verdict.reason}`);
    return { delivered: false, reason: verdict.reason };
  }

  const title = `Your ${alarm.type} alarm rang`;
  const body = wa.alertText({ title, line: change.line, url: alarm.url });

  if (channel === 'whatsapp') {
    if (!user.phone) return { delivered: false, reason: 'no phone on this account' };
    // Inside the 24h window a free-form text is allowed and cheaper to reason about;
    // outside it, only a pre-approved template may be used.
    await wa.sendTemplate(user.phone, {
      name: process.env.WHATSAPP_TEMPLATE || 'wedge_alert',
      lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
      params: [title, change.line]
    });
    store.recordAlert(user);
    return { delivered: true, channel: 'whatsapp', body };
  }

  // Email is free; swap this for Resend/SES when you have a key.
  console.log(`[email] to=${user.email || user.phone} :: ${body}`);
  return { delivered: true, channel: 'email', body };
}

/* ---------------------------------------------------------------- ticker */

let ticking = false;
async function tick(now = Date.now(), force = false) {
  if (ticking) return { skipped: 'already running' };
  ticking = true;
  const result = { checked: 0, changed: 0, alerted: 0 };
  try {
    const due = force
      ? Object.values(store.load().alarms).filter((a) => a.active && a.url)
      : store.dueAlarms(now);
    for (const alarm of due) {
      result.checked++;
      try {
        if (!alarm.url) { alarm.lastCheckedAt = now; store.saveAlarm(alarm); continue; }
        const text = await watcher.fetchPage(alarm.url);
        alarm.lastCheckedAt = now;
        if (!alarm.lastHash) {
          // first look is the baseline: learn the page, do not wake anyone up
          alarm.lastHash = watcher.fingerprint(text);
          alarm.lastText = text.slice(0, 20000);
          store.saveAlarm(alarm);
          continue;
        }
        const ev = watcher.evaluate(alarm, alarm.lastText, text);
        if (!ev.changed) { store.saveAlarm(alarm); continue; }

        result.changed++;
        alarm.lastHash = ev.hash;
        alarm.lastText = text.slice(0, 20000);
        alarm.lastAlertAt = now;
        store.saveAlarm(alarm);

        const owner = store.getUser(alarm.userKey);
        if (owner) {
          const out = await deliver(owner, alarm, ev.change);
          if (out.delivered) result.alerted++;
          else {
            // the plan does not allow an instant message: keep it for the digest
            alarm.pending = [...(alarm.pending || []), { line: ev.change.line, at: now }].slice(-10);
            store.saveAlarm(alarm);
          }
        }
      } catch (err) {
        alarm.lastCheckedAt = now;
        alarm.lastError = String(err.message || err).slice(0, 200);
        store.saveAlarm(alarm);
      }
    }
  } finally {
    ticking = false;
  }
  return result;
}

/* ---------------------------------------------------------------- digest */

const DIGEST_MS = Number(process.env.DIGEST_MS || 7 * 864e5);

/** One message a week for free users: everything that changed, rolled up. */
async function sendDigests(now = Date.now(), force = false) {
  const out = { users: 0, sent: 0 };
  for (const [key, user] of Object.entries(store.load().users)) {
    if (plans.planFor(user).instant) continue;              // paid users get instant alerts
    if (!force && now - (user.lastDigestAt || 0) < DIGEST_MS) continue;
    const mine = store.alarmsFor(key);
    const pending = mine.flatMap((a) => (a.pending || []).map((p) => ({ ...p, what: a.what, url: a.url })));
    if (!pending.length) continue;

    out.users++;
    const lines = pending.slice(0, 8).map((p) => `• ${p.what} — ${p.line}`);
    const body = `This week on your alarms:\n\n${lines.join('\n')}` +
      (pending.length > 8 ? `\n\nand ${pending.length - 8} more.` : '');

    console.log(`[digest] to=${user.email || user.phone} :: ${body.replace(/\n/g, ' | ')}`);
    for (const a of mine) { a.pending = []; store.saveAlarm(a); }
    store.updateUser(key, { lastDigestAt: now });
    out.sent++;
  }
  return out;
}

/* --------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS'
    });
    return res.end();
  }

  try {
    /* ---- static ---- */
    const PAGES = {
      '/': 'index.html', '/index.html': 'index.html',
      '/terms': 'public/terms.html', '/terms.html': 'public/terms.html',
      '/privacy': 'public/privacy.html', '/privacy.html': 'public/privacy.html',
      '/refund': 'public/refund.html', '/refund.html': 'public/refund.html'
    };
    if (req.method === 'GET' && PAGES[p]) {
      const file = path.join(ROOT, PAGES[p]);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'GET' && p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nDisallow: /api/\n');
    }

    /* ---- health ---- */
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        whatsapp: wa.configured() ? 'live' : 'dev',
        razorpay: rzp.configured() ? 'live' : 'dev',
        alarms: Object.keys(store.load().alarms).length,
        users: Object.keys(store.load().users).length,
        time: new Date().toISOString()
      });
    }

    /* ---- session ---- */
    if (p === '/api/session' && req.method === 'POST') {
      const body = await readJson(req);
      const user = store.getOrCreateUser({ phone: body.phone, email: body.email });
      const key = store.userKey({ phone: body.phone, email: body.email });
      const plan = plans.planFor(user);
      return json(res, 200, {
        key,
        user: { id: user.id, phone: user.phone, email: user.email, plan: plan.name },
        limits: { maxAlarms: plan.maxAlarms, instant: plan.instant, channels: plan.channels }
      });
    }

    /* ---- me ---- */
    if (p === '/api/me' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      const user = store.getUser(key);
      if (!user) return json(res, 404, { error: 'no such user' });
      const plan = plans.planFor(user);
      return json(res, 200, {
        plan: plan.name,
        expiresAt: user.planExpiresAt,
        alarms: store.alarmsFor(key).length,
        maxAlarms: plan.maxAlarms,
        alertsThisMonth: store.alertsSentThisMonth(user),
        maxAlertsPerMonth: plan.maxAlertsPerMonth
      });
    }

    /* ---- alarms ---- */
    if (p === '/api/alarms' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!store.getUser(key)) return json(res, 404, { error: 'no such user' });
      return json(res, 200, { alarms: store.alarmsFor(key) });
    }

    if (p === '/api/alarms' && req.method === 'POST') {
      const body = await readJson(req);
      const user = store.getUser(body.key);
      if (!user) return json(res, 404, { error: 'no such user' });

      const existing = store.alarmsFor(body.key);
      const room = plans.canAddAlarm(user, existing.length);
      if (!room.ok) return json(res, 402, { error: room.reason, upgrade: true });

      const channel = body.channel || 'email';
      if (!plans.channelsFor(user).includes(channel)) {
        return json(res, 402, { error: `Your plan cannot deliver on ${channel}.`, upgrade: true });
      }

      const parsed = parseAlarmText(body.text);
      if (!parsed.url && channel === 'whatsapp' && !body.url) {
        // a watch needs a page; accept a url field from the client
        if (body.url) parsed.url = body.url;
      }
      const alarm = store.createAlarm(body.key, { ...parsed, url: parsed.url || body.url || null, channel });
      return json(res, 201, { alarm });
    }

    if (p.startsWith('/api/alarms/') && req.method === 'DELETE') {
      const alarmId = p.split('/')[3];
      const key = url.searchParams.get('key');
      const ok = store.deleteAlarm(alarmId, key);
      return json(res, ok ? 200 : 404, { ok });
    }

    /* ---- billing ---- */
    if (p === '/api/billing/order' && req.method === 'POST') {
      const body = await readJson(req);
      const user = store.getUser(body.key);
      if (!user) return json(res, 404, { error: 'no such user' });

      const order = await rzp.createOrder({
        amountInr: plans.PLANS.whatsapp.priceInr,
        receipt: 'rcpt_' + user.id,
        notes: { userKey: body.key, plan: 'whatsapp' }
      });
      store.createOrder({
        orderId: order.id, userKey: body.key, amount: order.amount,
        currency: order.currency, dev: Boolean(order.dev)
      });
      return json(res, 200, {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID || null,
        dev: Boolean(order.dev)
      });
    }

    if (p === '/api/billing/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const user = store.getUser(body.key);
      if (!user) return json(res, 404, { error: 'no such user' });

      let valid = false;
      if (body.dev) {
        valid = DEV;                       // dev-mode stand-in, never in production
      } else {
        valid = rzp.verifyPaymentSignature({
          orderId: body.orderId, paymentId: body.paymentId, signature: body.signature
        });
      }
      if (!valid) return json(res, 400, { error: 'signature did not verify' });

      store.markOrderPaid(body.orderId, body.paymentId || 'dev');
      const expires = Date.now() + plans.PLANS.whatsapp.durationDays * 864e5;
      store.updateUser(body.key, { plan: 'whatsapp', planExpiresAt: expires });
      return json(res, 200, { ok: true, plan: 'whatsapp', expiresAt: expires });
    }

    /* ---- razorpay webhook ---- */
    if (p === '/api/webhooks/razorpay' && req.method === 'POST') {
      const raw = await readBody(req);
      const sig = req.headers['x-razorpay-signature'];
      let ok = false;
      try { ok = rzp.verifyWebhookSignature(raw, sig); }
      catch { ok = DEV; }
      if (!ok) return json(res, 400, { error: 'bad signature' });

      const evt = JSON.parse(raw.toString('utf8'));
      if (store.seenEvent(evt.event_id || evt.payload?.payment?.entity?.id || crypto.randomUUID())) {
        return json(res, 200, { ok: true, duplicate: true });
      }
      if (evt.event === 'payment.captured') {
        const notes = evt.payload?.payment?.entity?.notes || {};
        const key = notes.userKey;
        if (key && store.getUser(key)) {
          store.updateUser(key, {
            plan: 'whatsapp',
            planExpiresAt: Date.now() + plans.PLANS.whatsapp.durationDays * 864e5
          });
        }
      }
      return json(res, 200, { ok: true });
    }

    /* ---- whatsapp webhook ---- */
    if (p === '/api/webhooks/whatsapp' && req.method === 'GET') {
      const v = wa.verifyWebhook(Object.fromEntries(url.searchParams));
      if (!v.ok) { res.writeHead(403); return res.end('forbidden'); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(v.challenge);
    }

    if (p === '/api/webhooks/whatsapp' && req.method === 'POST') {
      const body = await readJson(req);
      const { messages } = wa.parseWebhook(body);

      for (const m of messages) {
        if (store.seenEvent(m.id)) continue;         // Meta retries; do not double-handle
        const user = store.getOrCreateUser({ phone: m.from });
        const key = store.userKey({ phone: m.from });
        const text = (m.text || '').trim();
        const plan = plans.planFor(user);

        if (/^(stop|pause|unsubscribe)$/i.test(text)) {
          for (const a of store.alarmsFor(key)) { a.active = false; store.saveAlarm(a); }
          await wa.sendText(m.from, 'Paused. Every alarm is off. Send "start" to turn them back on.');
          continue;
        }
        if (/^(start|resume)$/i.test(text)) {
          for (const a of store.alarmsFor(key)) { a.active = true; store.saveAlarm(a); }
          await wa.sendText(m.from, 'Back on.');
          continue;
        }
        if (/^(list|mine)$/i.test(text)) {
          const mine = store.alarmsFor(key).filter((a) => a.active);
          await wa.sendText(m.from, mine.length
            ? mine.map((a, i) => `${i + 1}. ${a.what}`).join('\n')
            : 'No alarms yet. Send me what you are waiting for.');
          continue;
        }

        const existing = store.alarmsFor(key);
        const room = plans.canAddAlarm(user, existing.length);
        if (!room.ok) {
          await wa.sendText(m.from, room.reason + ' Reply "list" to see what you have.');
          continue;
        }
        try {
          const parsed = parseAlarmText(text);
          store.createAlarm(key, { ...parsed, channel: plan.channels.includes('whatsapp') ? 'whatsapp' : 'email' });
          await wa.sendText(m.from,
            `Alarm set ✓\nWatching: ${parsed.what}\nChecking: every ${parsed.freqMinutes / 60} hours\nRings when: ${parsed.when}` +
            (parsed.url ? '' : '\n\nSend me the link too, otherwise I have nothing to watch.'));
        } catch (err) {
          await wa.sendText(m.from, 'I did not catch that. Try: "tell me when this laptop drops under ₹55,000" plus a link.');
        }
      }
      return json(res, 200, { ok: true });
    }

    /* ---- dev: force a digest ---- */
    if (p === '/api/dev/digest' && req.method === 'POST' && DEV) {
      return json(res, 200, await sendDigests(Date.now(), true));
    }

    /* ---- dev: force a tick ---- */
    if (p === '/api/dev/tick' && req.method === 'POST' && DEV) {
      const r = await tick(Date.now(), true);   // ignore the schedule, check everything now
      return json(res, 200, r);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[error]', err.message);
    return json(res, 400, { error: String(err.message || err) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Wedge on http://localhost:${PORT}`);
    console.log(`  whatsapp: ${wa.configured() ? 'live' : 'dev mode (nothing is sent)'}`);
    console.log(`  razorpay: ${rzp.configured() ? 'live' : 'dev mode (no charge)'}`);
    setInterval(() => tick().catch((e) => console.error('[tick]', e.message)), TICK_MS);
    setInterval(() => sendDigests().catch((e) => console.error('[digest]', e.message)), 3600e3);
  });
}

module.exports = { server, tick, sendDigests, parseAlarmText, deliver };
