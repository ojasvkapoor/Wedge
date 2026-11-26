# Wedge

Set it once, get told the moment something changes. Free on the web, ₹100 a year on WhatsApp.

```
wedge/
  index.html          the site (works standalone in demo mode)
  public/             terms, privacy, refund — served at /terms, /privacy, /refund
  DEPLOY.md           two deployment paths and the pre-launch checklist
  Dockerfile          single container, data on a volume
  Caddyfile           HTTPS reverse proxy config
  wedge.service       systemd unit for a VPS
  render.yaml         one-click Render blueprint
  server/
    server.js         API, scheduler, webhooks — zero dependencies
    lib/store.js      JSON persistence, atomic writes
    lib/watcher.js    fetch → text → fingerprint → "what changed"
    lib/whatsapp.js   Cloud API: webhook verify, inbound parse, outbound send
    lib/razorpay.js   orders, payment signature, webhook signature
    lib/plans.js      the limits that protect your message bill
    test/run.js       50 tests, no network or credentials needed
```

## Run it

```bash
cd server
node server.js            # http://localhost:8787
```

Then open http://localhost:8787 — the site is served by the same process.

Tests:

```bash
node test/run.js          # 50 passing, no keys required
```

Without credentials the server runs in **dev mode**: WhatsApp messages are
logged instead of sent, and payments complete without charging anyone. The
whole flow is exercisable before you sign up for anything.

## Configuration

Copy `.env.example` to `.env` and fill in what you have. Nothing is required
to run locally.

| Variable | What it does |
|---|---|
| `PORT` | default 8787 |
| `DATA_FILE` | where the JSON database lives |
| `TICK_MS` | how often the scheduler wakes, default 60000 |
| `WHATSAPP_TOKEN` | Meta Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | the sender number |
| `WHATSAPP_VERIFY_TOKEN` | the string you type into Meta's webhook form |
| `WHATSAPP_TEMPLATE` | approved template name, default `wedge_alert` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | payments |
| `RAZORPAY_WEBHOOK_SECRET` | webhook verification |

## WhatsApp setup

1. Create a Meta app, add the WhatsApp product, and take the **permanent**
   token and the **phone number ID** from the API setup page.
2. Set the webhook URL to `https://your-domain/api/webhooks/whatsapp` and the
   verify token to `WHATSAPP_VERIFY_TOKEN`.
3. Subscribe to the `messages` field.
4. Create a **utility** template named `wedge_alert` with two body variables:
   `{{1}}` is the title, `{{2}}` is the change line. Wait for approval.

Inbound messages are free and open a 24-hour window, so the bot's replies cost
nothing. Business-initiated alerts must use the approved template and are
billed — about ₹0.115 per delivered message in India.

## Razorpay setup

1. Take the key id and secret from the dashboard.
2. Add a webhook to `https://your-domain/api/webhooks/razorpay`, subscribe to
   `payment.captured`, and put the secret in `RAZORPAY_WEBHOOK_SECRET`.

Two independent paths grant the plan, and both are checked: the checkout
callback (HMAC of `order_id|payment_id`) and the webhook (HMAC of the raw body).
Either one alone is enough; both together survive a dropped callback.

## The numbers that matter

| | |
|---|---|
| WhatsApp utility message, India | ₹0.115 |
| Free user, weekly digest | 4 messages/month ≈ ₹0.46 |
| Paid user at the 100-alert cap | ₹11.50/month |
| ₹100/year plan, heavy user | still profitable |

The cap is not a paywall trick — it is what stops a free user from costing you
money. `lib/plans.js` is the only place those limits live.

## Deploying

Webhooks need a public HTTPS URL, so run it behind Caddy or nginx with TLS.
Any box that runs Node 20 works; there is no build step and no dependency tree.

Before going live, check three things: `NODE_ENV=production` (this disables the
dev payment branch), a real `DATA_FILE` on persistent storage, and that the
Graph API version in `lib/whatsapp.js` is still current.

## What is not built yet

- Email sending is a `console.log` placeholder — swap in Resend or SES.
- No dashboard: alarms are managed from the site or by messaging the bot.
- The parser is keyword-based. A page that needs a CSS selector will watch the
  whole page and ring too often; per-site selectors are the next layer.
