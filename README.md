# Global Talent Club platform trial

Trial build of the Global Talent intake platform, law firm portal and CRM, in one page (`index.html`).

## Two ways it runs

- **Inside claude.ai (artifact):** live shared data, file uploads, AI profile reading and relevance checks.
- **Standalone (GitHub Pages or any browser):** data is saved in the visitor's browser only (localStorage and IndexedDB), sample clients and firms load on first visit, AI reading is switched off and the client picks their field by hand. Use "Reset demo data" in the CRM to start again.

## Simulated in this trial

- Google and Apple sign-in buttons collect name and email instead of real OAuth.
- Emails are logged in the CRM outbox instead of being sent.
- The LinkedIn URL is stored but not read; clients upload a CV or LinkedIn PDF.

Not for real client data.
