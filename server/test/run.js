'use strict';
/* Tests for the alarm server. No network, no credentials: everything that
   talks to Meta or Razorpay runs in its dev branch, and the watcher is pointed
   at a fixture server on localhost. */

process.env.DATA_FILE = '/tmp/alarm-test-db.json';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_key';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.NODE_ENV = 'development';

const fs = require('node:fs');
try { fs.unlinkSync(process.env.DATA_FILE); } catch {}

const crypto = require('node:crypto');
const http = require('node:http');

const store = require('../lib/store');
const plans = require('../lib/plans');
const watcher = require('../lib/watcher');
const wa = require('../lib/whatsapp');
const rzp = require('../lib/razorpay');
const { server, tick, parseAlarmText } = require('../server');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

const get = (base, p) => fetch(base + p).then(r => r.json().then(b => ({ status: r.status, body: b })));
const post = (base, p, body, headers) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(headers || {}) },
  body: JSON.stringify(body)
}).then(r => r.json().then(b => ({ status: r.status, body: b })));

(async () => {
  /* ---------------------------------------------------------------- watcher */
  console.log('\n== watcher ==');
  const html = '<html><head><style>.a{}</style><script>var x=1</script></head><body><h1>Price</h1><p>₹61,000</p></body></html>';
  const text = watcher.extractText(html);
  ok('strips tags and scripts', text.includes('Price') && !text.includes('var x'), text);

  const t1 = 'Price ₹61,000 updated at 10:41:22';
  const t2 = 'Price ₹61,000 updated at 11:02:09';
  ok('timestamps do not count as a change', watcher.fingerprint(t1) === watcher.fingerprint(t2));

  const t3 = 'Price ₹54,300 updated at 11:02:09';
  ok('a new price does count', watcher.fingerprint(t1) !== watcher.fingerprint(t3));

  const change = watcher.describeChange('the price is ₹61,000 today', 'the price is ₹54,300 today', 'price');
  ok('change says which way it moved', /fell from ₹61,000 to ₹54,300/.test(change.line), change.line);
  ok('change carries the percentage', change.pct !== null && change.pct < 0, change.pct);

  const same = watcher.evaluate({ lastHash: watcher.fingerprint(t1), type: 'price' }, t1, t1);
  ok('unchanged page produces no alert', same.changed === false, same);

  /* ------------------------------------------------------------------ plans */
  console.log('\n== plans ==');
  const freeUser = { plan: 'free', alertsThisMonth: {} };
  const paidUser = { plan: 'whatsapp', planExpiresAt: Date.now() + 864e5, alertsThisMonth: {} };

  ok('free user blocked at the 4th alarm', plans.canAddAlarm(freeUser, 3).ok === false);
  ok('free user allowed at the 3rd', plans.canAddAlarm(freeUser, 2).ok === true);
  ok('paid user blocked at the 11th alarm', plans.canAddAlarm(paidUser, 10).ok === false);
  ok('paid user allowed at the 10th', plans.canAddAlarm(paidUser, 9).ok === true);
  ok('free user never gets an instant alert', plans.canAlert(freeUser, 0, 'whatsapp').ok === false);
  ok('paid user gets one', plans.canAlert(paidUser, 0, 'whatsapp').ok === true);
  ok('monthly cap stops the 101st alert', plans.canAlert(paidUser, 100, 'whatsapp').ok === false);
  ok('monthly cap allows the 100th', plans.canAlert(paidUser, 99, 'whatsapp').ok === true);
  ok('an expired plan falls back to free', plans.planFor({ plan: 'whatsapp', planExpiresAt: Date.now() - 1000 }).name === 'Free');

  /* --------------------------------------------------------------- razorpay */
  console.log('\n== razorpay signatures ==');
  const orderId = 'order_ABC123', paymentId = 'pay_XYZ789';
  const goodSig = crypto.createHmac('sha256', 'test_secret_key').update(orderId + '|' + paymentId).digest('hex');
  ok('valid payment signature accepted', rzp.verifyPaymentSignature({ orderId, paymentId, signature: goodSig }) === true);
  ok('forged payment signature rejected', rzp.verifyPaymentSignature({ orderId, paymentId, signature: 'deadbeef' }) === false);
  ok('swapped order id rejected', rzp.verifyPaymentSignature({ orderId: 'order_OTHER', paymentId, signature: goodSig }) === false);

  const raw = JSON.stringify({ event: 'payment.captured' });
  const whSig = crypto.createHmac('sha256', 'test_webhook_secret').update(raw).digest('hex');
  ok('valid webhook signature accepted', rzp.verifyWebhookSignature(raw, whSig) === true);
  ok('webhook body tampering rejected', rzp.verifyWebhookSignature(raw + ' ', whSig) === false);

  /* --------------------------------------------------------------- whatsapp */
  console.log('\n== whatsapp webhook ==');
  ok('handshake with the right token', wa.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' }).challenge === '12345');
  ok('handshake with a wrong token refused', wa.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' }).ok === false);

  const inbound = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '919876543210', type: 'text', timestamp: '1700000000', text: { body: 'tell me when this drops under ₹55,000' } }] } }] }]
  };
  const parsed = wa.parseWebhook(inbound);
  ok('inbound message parsed', parsed.messages.length === 1 && parsed.messages[0].from === '919876543210', parsed.messages);
  ok('inbound text extracted', parsed.messages[0].text.includes('55,000'));

  /* ------------------------------------------------------------- live server */
  console.log('\n== end to end ==');
  let pagePrice = '₹61,000';
  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><h1>Sony WH-1000XM5</h1><p>${pagePrice}</p></body></html>`);
  });
  await new Promise(r => fixture.listen(0, r));
  const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port + '/product';

  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const health = await get(base, '/api/health');
  ok('health endpoint responds', health.body.ok === true && health.body.whatsapp === 'dev', health.body);

  const sess = await post(base, '/api/session', { phone: '919876543210' });
  ok('session created', sess.status === 200 && sess.body.key === 'p:919876543210', sess.body);
  const key = sess.body.key;

  // free plan: 3 alarms, no whatsapp
  const a1 = await post(base, '/api/alarms', { key, text: 'tell me when this laptop drops under ₹55,000', url: fixtureUrl });
  ok('alarm created', a1.status === 201 && a1.body.alarm.type === 'price', a1.body);
  await post(base, '/api/alarms', { key, text: 'new jobs at Razorpay', url: fixtureUrl });
  await post(base, '/api/alarms', { key, text: 'when IIT-B announces fest dates', url: fixtureUrl });
  const a4 = await post(base, '/api/alarms', { key, text: 'a fourth alarm', url: fixtureUrl });
  ok('free plan blocks the 4th alarm', a4.status === 402 && a4.body.upgrade === true, a4.body);

  const waBlocked = await post(base, '/api/alarms', { key, text: 'price alarm', url: fixtureUrl, channel: 'whatsapp' });
  ok('free plan cannot pick whatsapp', waBlocked.status === 402, waBlocked.body);

  // first tick learns the page and stays quiet
  let t = await post(base, '/api/dev/tick', {});
  ok('first tick checks pages', t.body.checked >= 1, t.body);
  ok('first tick sends nothing', t.body.alerted === 0, t.body);

  // the page changes
  pagePrice = '₹54,300';
  t = await post(base, '/api/dev/tick', {});
  ok('a real change is detected', t.body.changed >= 1, t.body);
  ok('free plan sends no instant message', t.body.alerted === 0, t.body);

  const digest = await post(base, '/api/dev/digest', {});
  ok('free plan gets a digest instead', digest.body.sent >= 1, digest.body);

  const afterDigest = (await get(base, '/api/alarms?key=' + encodeURIComponent(key))).body.alarms[0];
  ok('digest clears what it reported', (afterDigest.pending || []).length === 0, afterDigest.pending);

  const alarmAfter = (await get(base, '/api/alarms?key=' + encodeURIComponent(key))).body.alarms[0];
  ok('alarm remembers the new text', /54,300/.test(alarmAfter.lastText || ''), alarmAfter.lastText);

  // paying
  const order = await post(base, '/api/billing/order', { key });
  ok('order created in dev mode', order.status === 200 && order.body.dev === true, order.body);
  const badPay = await post(base, '/api/billing/verify', { key, orderId: order.body.orderId, paymentId: 'pay_1', signature: 'forged' });
  ok('forged payment refused', badPay.status === 400, badPay.body);

  const goodPay = await post(base, '/api/billing/verify', { key, orderId: order.body.orderId, paymentId: 'pay_1', dev: true });
  ok('dev payment upgrades the plan', goodPay.status === 200 && goodPay.body.plan === 'whatsapp', goodPay.body);

  const me = await get(base, '/api/me?key=' + encodeURIComponent(key));
  ok('upgraded user gets 10 alarms', me.body.maxAlarms === 10, me.body);
  ok('upgraded user has an expiry a year out', me.body.expiresAt - Date.now() > 300 * 864e5, me.body.expiresAt);

  const waNow = await post(base, '/api/alarms', { key, text: 'price on this laptop', url: fixtureUrl, channel: 'whatsapp' });
  ok('upgraded user can pick whatsapp', waNow.status === 201 && waNow.body.alarm.channel === 'whatsapp', waNow.body);

  // whatsapp delivery path, dev mode: one tick to learn the page, one to ring
  t = await post(base, '/api/dev/tick', {});
  ok('the new whatsapp alarm is baselined first', t.body.alerted === 0, t.body);

  pagePrice = '₹49,999';
  t = await post(base, '/api/dev/tick', {});
  ok('whatsapp alarm rings on change', t.body.alerted >= 1, t.body);

  const me2 = await get(base, '/api/me?key=' + encodeURIComponent(key));
  ok('the monthly counter moved', me2.body.alertsThisMonth >= 1, me2.body);

  // inbound whatsapp message creates an alarm
  const inboundBody = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in1', from: '919000000001', type: 'text', timestamp: '1700000000', text: { body: 'tell me when the exam date is announced for NEET' } }] } }] }]
  };
  const wh = await post(base, '/api/webhooks/whatsapp', inboundBody);
  ok('inbound webhook accepted', wh.status === 200, wh.body);
  const whDup = await post(base, '/api/webhooks/whatsapp', inboundBody);
  ok('duplicate message id is ignored', whDup.body.ok === true, whDup.body);

  const newUserKey = 'p:919000000001';
  const theirs = (await get(base, '/api/alarms?key=' + encodeURIComponent(newUserKey))).body.alarms;
  ok('a message from a new number creates their alarm', theirs.length === 1, theirs);

  const verifyGet = await fetch(base + '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=98765');
  ok('webhook handshake served over http', verifyGet.status === 200 && (await verifyGet.text()) === '98765');

  // deleting
  const del = await fetch(base + '/api/alarms/' + a1.body.alarm.id + '?key=' + encodeURIComponent(key), { method: 'DELETE' });
  ok('alarm deleted', del.status === 200);

  server.close();
  fixture.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
