# Global Talent Club platform trial

Trial build of the Global Talent intake platform, law firm portal and CRM, in one page (`index.html`), plus a small lookup service (`worker.js`) that runs on Cloudflare.

Live page: https://hylaspart.github.io/gtc-platform/

## What fills itself in

- **Sign-up:** Google sign-in gives the client's name, email and photo. Email sign-up is the fallback.
- **About you:** the client pastes their LinkedIn link. The profile (roles, education, awards, publications, certificates, languages) is read automatically and the field is suggested from it. A CV upload is the fallback.
- **Referees:** the client pastes each referee's LinkedIn link. Name, role, organisation, country and UK status fill in. If both worked at the same organisation, "known since" and "how they know your work" fill in too.
- **Evidence:** the client drops in files or pastes links. Title, category, language, source and date fill in, and each item gets a format check and a relevance check.

Field matching and evidence checks use keyword rules by default. Adding a Claude API key to the Worker switches them to Claude.

## The lookup service (worker.js)

The page is public, so it cannot hold secret keys. `worker.js` runs on Cloudflare Workers and holds them instead:

| Setting in Cloudflare | Type | What it is |
|---|---|---|
| `APIFY_TOKEN` | Secret | Apify API token. Needed for LinkedIn reading. |
| `GOOGLE_CLIENT_ID` | Text | The Google OAuth Client ID. When set, only signed-in users can run lookups. |
| `ALLOWED_ORIGINS` | Text | `https://hylaspart.github.io` |
| `ANTHROPIC_API_KEY` | Secret, optional | Turns on Claude for field matching and evidence checks. |

LinkedIn profiles are read with the Apify actor `harvestapi~linkedin-profile-scraper` (no cookies, about $4 per 1,000 profiles).

## Connecting the page

The two public values go in `CONFIG` at the top of the script in `index.html`:

- `googleClientId`: the Google OAuth Client ID (its authorised JavaScript origin must be `https://hylaspart.github.io`)
- `apiBase`: the Worker address, for example `https://gtc-api.yourname.workers.dev`

To test before editing the file, paste them in CRM > Setup. They are then saved in that browser only.

## Still simulated

- Emails are logged in the CRM outbox instead of being sent.
- Data is saved in each visitor's browser (localStorage and IndexedDB), not in a shared database. Use "Reset demo data" in the CRM to start again.

Not for real client data.
