# Deploying Wedge

Two paths. Pick the first one today, the second one before you take money.

---

## A. Render — five minutes, free, for testing webhooks

Free plan has **no persistent disk**, so accounts reset on every deploy. Use it to prove the
webhook works, not to run a business.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Blueprint**, pick the repo. It reads `render.yaml`.
3. Once it's live you get a URL like `https://wedge-xxxx.onrender.com`.
4. Open `https://wedge-xxxx.onrender.com/api/health` — it should return `{"ok":true,...}`.
5. In Meta → WhatsApp → Step 2, set:

   - **Callback URL:** `https://wedge-xxxx.onrender.com/api/webhooks/whatsapp`
   - **Verify token:** the value Render generated for `WHATSAPP_VERIFY_TOKEN`
     (Settings → Environment — copy it exactly)

6. Free instances sleep after 15 minutes idle, which makes the first webhook after a nap slow.
   For anything real, use path B.

---

## B. A small VPS — about ₹500 a month, the real thing

Any 1 GB Ubuntu box works. You need a domain pointed at it first.

**1. Install Node 20**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs caddy
```

**2. Put the app in place**

```bash
sudo mkdir -p /opt/wedge
sudo useradd --system --home /opt/wedge wedge
sudo cp -r wedge/* /opt/wedge/
sudo cp wedge/.env.example /opt/wedge/.env
sudo chown -R wedge:wedge /opt/wedge
sudo nano /opt/wedge/.env          # fill in the keys
```

**3. Run it as a service**

```bash
sudo cp /opt/wedge/wedge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wedge
sudo systemctl status wedge        # should say active (running)
```

**4. HTTPS**

```bash
sudo cp /opt/wedge/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # replace wedge.example.com with your domain
sudo systemctl reload caddy
```

Caddy fetches the certificate automatically. `https://yourdomain.com` should now serve the site.

**5. Point Meta at it**

- Callback URL: `https://yourdomain.com/api/webhooks/whatsapp`
- Verify token: whatever is in `WHATSAPP_VERIFY_TOKEN`

**6. Backups**

```bash
# the whole database is one JSON file
sudo cp /opt/wedge/data/db.json ~/wedge-$(date +%F).json
```

Put that in cron, or point `DATA_FILE` at a directory your host backs up.

---

## Before you take money

- [ ] All three policy pages are live: `/terms`, `/privacy`, `/refund`
- [ ] Every `[PLACEHOLDER]` on those pages is replaced with real details
- [ ] The yellow **"Before you publish this"** box is deleted from all three pages
- [ ] A support email exists and you actually read it
- [ ] `NODE_ENV=production` — this disables the dev payment branch
- [ ] `DATA_FILE` is on a disk that survives a redeploy
- [ ] `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are the **live** keys, not test keys
- [ ] The Razorpay webhook points at `https://yourdomain.com/api/webhooks/razorpay`
- [ ] You have sent one real WhatsApp alert to your own phone

## The placeholders to replace

| File | Placeholder |
|---|---|
| `public/terms.html` | `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]`, `[SUPPORT EMAIL]`, `[CITY]` |
| `public/privacy.html` | `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]`, `[SUPPORT EMAIL]` |
| `public/refund.html` | `[SUPPORT EMAIL]` |

Search for `[` in the `public/` folder to find them all.
