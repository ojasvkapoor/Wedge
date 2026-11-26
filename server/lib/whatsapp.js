'use strict';
/* WhatsApp Cloud API: verify the webhook, read inbound messages, send outbound.
   Outbound is the expensive half — every business-initiated message is billed. */

const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'change-me';
const GRAPH = process.env.GRAPH_VERSION || 'v21.0';   // check the current version before launch

const configured = () => Boolean(TOKEN && PHONE_ID);

/** GET /webhooks/whatsapp — Meta's subscription handshake. */
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return { ok: true, challenge };
  }
  return { ok: false, status: 403 };
}

/** Read the inbound payload into something plain. */
function parseWebhook(body) {
  const out = { messages: [], statuses: [] };
  if (!body || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const m of v.messages || []) {
        out.messages.push({
          id: m.id,
          from: m.from,
          type: m.type,
          text: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '',
          timestamp: Number(m.timestamp) * 1000
        });
      }
      for (const s of v.statuses || []) {
        out.statuses.push({ id: s.id, status: s.status, recipient: s.recipient_id, pricing: s.pricing });
      }
    }
  }
  return out;
}

async function post(payload) {
  if (!configured()) {
    // dev mode: no token, so record the intent instead of spending money
    return { dev: true, payload, messageId: 'wamid.dev.' + Date.now() };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    throw new Error('WhatsApp send failed: ' + msg);
  }
  return { messageId: data.messages?.[0]?.id, raw: data };
}

/**
 * Free-form reply. Only valid inside the 24-hour customer service window,
 * which opens when the user messages you.
 */
function sendText(to, body) {
  return post({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body }
  });
}

/**
 * Business-initiated message. Must be a pre-approved template, and it is billed.
 * The template body should read like: "{{1}} — {{2}}"
 */
function sendTemplate(to, { name, lang = 'en', params = [] }) {
  return post({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: lang },
      components: params.length
        ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }]
        : []
    }
  });
}

/** The alert message itself, kept to one line plus one detail line. */
function alertText({ title, line, url }) {
  const parts = [title || 'Your alarm rang', line];
  if (url) parts.push(url);
  return parts.join('\n');
}

module.exports = { verifyWebhook, parseWebhook, sendText, sendTemplate, alertText, configured };
