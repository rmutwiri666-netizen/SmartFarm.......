# SmartFarm

SmartFarm is a small Node.js app with seller accounts and a shared marketplace. Public visitors can browse listings; sellers sign in to publish products under their farm name.

## Run locally

Install Node.js 22.5 or newer, then install the dependencies and start the server:

```powershell
npm install
npm start
```

Open `http://127.0.0.1:3000`. Create a seller account from the **Sign in** button, then publish from **Advertise**. Accounts, sessions, and products are stored in the relational SQLite database at `data/smartfarm.sqlite`; the public products API serves those products to all visitors using the same running server. The server refreshes the marketplace every 15 seconds while a page is open.

If `data/smartfarm.json` exists from an earlier version, the server imports its users, sessions, and listings once on startup. The JSON file is kept as a backup and is not updated after migration.

Run the backend tests with:

```powershell
npm test
```

## Deploy With GitHub Pages

GitHub Pages hosts only the static website; it cannot run the Node.js server. `render.yaml` configures a Render Node web service and a managed PostgreSQL database. The API seeds SmartFarm Wholesale listings, including maize, and stores seller adverts in PostgreSQL.

1. Push the project to the GitHub repository used by the Pages site.
2. In Render, create a new Blueprint and select that repository. Render reads `render.yaml` and asks for secret values. Set `SMARTFARM_ALLOWED_ORIGINS` to the exact Pages origin, such as `https://your-account.github.io` or your custom domain, with no path or trailing slash. Set `MPESA_CALLBACK_URL` to `https://smartfarm-api.onrender.com/api/payments/mpesa/callback` (replace the hostname if Render assigns a different service URL).
3. After Render deploys, check `/api/health` on the service URL. It should report `"database":"postgres"`.
4. If the service URL is not `https://smartfarm-api.onrender.com`, update `api-config.js` to the URL Render assigned, then push the change so GitHub Pages redeploys.

To enable M-Pesa, add the Daraja `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PARTY_B`, and `MPESA_PASSKEY` values in Render. Keep `MPESA_ENV=sandbox` while testing with Safaricom's sandbox credentials. Production payments require approved production credentials; set `MPESA_ENV=production` only after Safaricom approves the shortcode and callback URL. Never put these secrets in GitHub Pages or source files. Checkout currently charges seller subscriptions only; product-order payments are not implemented.

The Render blueprint uses an always-on paid web service and a **paid, persistent Postgres database**. Review Render's current pricing before creating the Blueprint; both may incur charges. The `SMARTFARM_ALLOWED_ORIGINS` setting must match the real Pages domain or browsers will block API access.

The default local server uses SQLite at `data/smartfarm.sqlite`. When a `DATABASE_URL` is configured, the server uses PostgreSQL instead. Existing JSON data is imported once and retained as a backup. Keep the entire `data/` directory private.
