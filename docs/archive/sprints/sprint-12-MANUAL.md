THIS SPRINT REQUIRES YOU (CARSON) TO BE PRESENT. DO NOT RUN AS COWORK OR SCHEDULED TASK.

This sprint covers infrastructure tasks that require authenticated access to cloud services. You need to provide credentials and approve operations.

Before starting this session, do these things yourself first:
1. Run `gcloud auth login` in your terminal
2. Have Stripe dashboard open in your browser
3. Have Supabase dashboard open in your browser
4. Have Cloudflare dashboard open in your browser

Then start a normal Claude Code session and paste this prompt:

---

I'm continuing work on the Arkova project. Read CLAUDE.md, HANDOFF.md, and MEMORY.md for full context.

This is Sprint 12 — manual infrastructure setup. I am present and will provide credentials and approvals as needed.

Tasks (work through these with me one at a time):
1. GCP Cloud Run: Set environment variables on the worker service (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BITCOIN_TREASURY_WIF, BITCOIN_NETWORK). I will provide the values.
2. Stripe: Help me register the webhook endpoint URL (https://arkova-worker-kvojbeutfa-uc.a.run.app/webhooks/stripe) in Stripe dashboard. Walk me through the steps.
3. DNS: Configure custom domain (app.arkova.io or equivalent) pointing to Vercel. Walk me through the steps.
4. Sentry: Set DSN environment variables in both Vercel (VITE_SENTRY_DSN) and Cloud Run (SENTRY_DSN). I will provide the DSN.
5. Verify end-to-end: Create a test anchor through the UI, confirm it processes through the worker.

No PR needed — this is infrastructure configuration.

Update MEMORY.md with infrastructure status after each step.
