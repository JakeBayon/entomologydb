# Deploying the Cloudflare Worker (fm-proxy)

## One-time setup

1. Install wrangler (Cloudflare CLI):
   ```
   npm install -g wrangler
   ```

2. Log in to Cloudflare (use Geoffrey's account or create one):
   ```
   wrangler login
   ```

3. Copy the `cloudflare-worker/` folder into your repo root

4. Set the secrets (same values as your Supabase secrets):
   ```
   cd cloudflare-worker
   wrangler secret put FM_URL
   # paste: https://bedding-visits-rehab-source.trycloudflare.com
   
   wrangler secret put FM_USER
   # paste: pass
   
   wrangler secret put FM_PASS
   # paste: pass
   ```

5. Deploy:
   ```
   wrangler deploy
   ```

6. Wrangler will output a URL like:
   ```
   https://fm-proxy.your-account.workers.dev
   ```

7. Update `Frontend/shared/config.js`:
   ```js
   export const CONFIG = {
     fileMakerUrl: 'https://fm-proxy.your-account.workers.dev',
   };
   ```

## Custom domain (after you set up bruchindb.org)

1. In Cloudflare dashboard, go to Workers > fm-proxy > Settings > Triggers
2. Add Custom Domain: `api.bruchindb.org`
3. Update config.js:
   ```js
   fileMakerUrl: 'https://api.bruchindb.org',
   ```

## How caching works

- Search results: cached 5 minutes
- Species detail pages: cached 1 hour  
- Images: cached 24 hours
- When Geoffrey updates FileMaker, changes appear within the cache TTL

## If something breaks

- Check the Worker logs: Cloudflare dashboard > Workers > fm-proxy > Logs
- Purge cache: Dashboard > Workers > fm-proxy > Settings > Purge Cache
- Re-deploy: `cd cloudflare-worker && wrangler deploy`

## Cost

- Free tier: 100,000 requests/day (more than enough)
- No monthly cost
- Never pauses or sleeps
