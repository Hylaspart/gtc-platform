/**
 * Global Talent Club platform: lookup proxy (Cloudflare Worker)
 *
 * What it does
 *   GET  /health    -> which services are switched on (no sign-in needed)
 *   POST /linkedin  -> {url} reads a public LinkedIn profile through Apify and returns a clean profile
 *   POST /meta      -> {url} reads a web page and returns its title, source, date and language
 *   POST /ai        -> {prompt, tier} optional, only if ANTHROPIC_API_KEY is set
 *
 * Settings (Cloudflare dashboard: Worker > Settings > Variables and Secrets)
 *   APIFY_TOKEN        Secret. Your Apify API token. Required for /linkedin.
 *   GOOGLE_CLIENT_ID   Text. Your Google OAuth Client ID. When set, every lookup needs a signed-in Google user.
 *   ALLOWED_ORIGINS    Text. Comma-separated sites allowed to call this Worker. Default: https://hylaspart.github.io
 *   APIFY_ACTOR        Text, optional. Default: harvestapi~linkedin-profile-scraper
 *   ANTHROPIC_API_KEY  Secret, optional. Turns on /ai (Claude) for field matching and evidence checks.
 *   AI_MODEL_QUICK, AI_MODEL_DEFAULT  Text, optional. Claude model names.
 *
 * The keys never leave Cloudflare. The page only ever sees the results.
 */

const DEFAULT_ORIGINS = 'https://hylaspart.github.io';
const DEFAULT_ACTOR = 'harvestapi~linkedin-profile-scraper';
const MONTHS = {jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  'янв':1, 'фев':2, 'мар':3, 'апр':4, 'май':5, 'мая':5, 'июн':6, 'июл':7, 'авг':8, 'сен':9, 'окт':10, 'ноя':11, 'дек':12};

const memCache = new Map();          // per-isolate cache: profile slug -> {at, data}
const tokenCache = new Map();        // per-isolate cache: Google token -> {exp, user}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    const okOrigin = allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin && origin ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (origin && !okOrigin) return json({error: 'origin_not_allowed'}, 403, cors);

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/health') {
        return json({ok: true, linkedin: !!env.APIFY_TOKEN, meta: true, ai: !!env.ANTHROPIC_API_KEY, auth: !!env.GOOGLE_CLIENT_ID}, 200, cors);
      }
      if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405, cors);

      if (env.GOOGLE_CLIENT_ID) {
        const user = await verifyGoogle(request, env);
        if (!user) return json({error: 'auth_required'}, 401, cors);
      }
      const body = await request.json().catch(() => ({}));

      if (path === '/linkedin') return json(await linkedin(body, env), 200, cors);
      if (path === '/meta') return json(await meta(body), 200, cors);
      if (path === '/ai') return json(await ai(body, env), 200, cors);
      return json({error: 'not_found'}, 404, cors);
    } catch (e) {
      const status = e && e.status || 500;
      return json({error: e && e.code || 'server_error', detail: String(e && e.message || e).slice(0, 300)}, status, cors);
    }
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {status, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8'}});
}
function fail(code, status, message) { const e = new Error(message || code); e.code = code; e.status = status; return e; }

/* ---------- Google sign-in check ---------- */
async function verifyGoogle(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tok = m[1].trim();
  const hit = tokenCache.get(tok);
  if (hit && hit.exp > Date.now()) return hit.user;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok));
  if (!r.ok) return null;
  const p = await r.json().catch(() => null);
  if (!p || p.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
  const exp = Number(p.exp) * 1000;
  if (!exp || exp < Date.now()) return null;
  const user = {sub: p.sub, email: p.email};
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(tok, {exp, user});
  return user;
}

/* ---------- LinkedIn profile via Apify ---------- */
function liSlug(u) {
  const m = String(u || '').trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
}

async function linkedin(body, env) {
  if (!env.APIFY_TOKEN) throw fail('not_configured', 503, 'APIFY_TOKEN is not set');
  const slug = liSlug(body && body.url);
  if (!slug) throw fail('bad_url', 400, 'Use a profile link like https://www.linkedin.com/in/name');
  const url = 'https://www.linkedin.com/in/' + encodeURIComponent(slug).replace(/%2D/gi, '-') + '/';

  const cached = memCache.get(slug);
  if (cached && Date.now() - cached.at < 7 * 864e5) return {...cached.data, cached: true};
  const cacheKey = new Request('https://gtc-cache.invalid/li/' + encodeURIComponent(slug));
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) { const d = await hit.json(); memCache.set(slug, {at: Date.now(), data: d}); return {...d, cached: true}; }
  } catch (e) {}

  const actor = env.APIFY_ACTOR || DEFAULT_ACTOR;
  const input = /^harvestapi[~/]/.test(actor)
    ? {profileScraperMode: 'Profile details no email ($4 per 1k)', queries: [url]}
    : {profileUrls: [url], urls: [url]};
  const api = `https://api.apify.com/v2/acts/${actor.replace('/', '~')}/run-sync-get-dataset-items?timeout=120&clean=true`;
  const r = await fetch(api, {method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.APIFY_TOKEN}, body: JSON.stringify(input)});
  if (r.status === 401 || r.status === 403) throw fail('apify_auth', 502, 'Apify rejected the token');
  if (r.status === 402) throw fail('apify_credit', 502, 'Apify account is out of credit');
  if (r.status === 408) throw fail('timeout', 504, 'Apify took too long');
  if (!r.ok) throw fail('apify_error', 502, 'Apify returned ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const items = await r.json().catch(() => []);
  const item = (Array.isArray(items) ? items : []).find(x => x && typeof x === 'object' && !x.error && (x.firstName || x.fullName || x.name || x.headline || x.experience || x.positions));
  if (!item) throw fail('not_found', 404, 'No public profile found at this link');

  const data = normalizeProfile(item, url);
  memCache.set(slug, {at: Date.now(), data});
  if (memCache.size > 300) memCache.delete(memCache.keys().next().value);
  try { await caches.default.put(cacheKey, new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800'}})); } catch (e) {}
  return data;
}

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function pick(o, ...paths) {
  for (const p of paths) {
    const v = get(o, p);
    if (v == null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    return v;
  }
  return undefined;
}
function txt(v, n = 300) {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim().slice(0, n);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return txt(v.text || v.name || v.title || v.linkedinText || v.default || v.full || '', n);
  return '';
}
function ym(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'object') {
    const y = d.year || d.y;
    let m = d.month || d.m;
    if (typeof m === 'string' && !/^\d+$/.test(m)) m = MONTHS[m.slice(0, 3).toLowerCase()];
    if (y) return m ? `${y}-${String(m).padStart(2, '0')}` : String(y);
    if (d.text) return ym(d.text);
    return '';
  }
  const s = String(d).trim();
  if (/present|current|now|настоящ|по н\.?в/i.test(s)) return 'present';
  let m = s.match(/(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/([A-Za-zА-Яа-яё]{3})[A-Za-zА-Яа-яё]*\.?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = s.match(/(\d{4})/);
  return m ? m[1] : '';
}
function range(e) {
  let start = ym(pick(e, 'startDate', 'start', 'starts_at', 'dateRange.start', 'timePeriod.startDate', 'date_from', 'from'));
  let end = ym(pick(e, 'endDate', 'end', 'ends_at', 'dateRange.end', 'timePeriod.endDate', 'date_to', 'to'));
  if (!start) {
    const s = txt(pick(e, 'caption', 'duration', 'period', 'dates', 'date', 'subtitle2'), 120);
    const parts = s.split(/\s+(?:-|\u2013|\u2014|to|по)\s+/);
    if (parts.length > 1) { start = ym(parts[0]); end = ym(parts[1].split('·')[0]); }
  }
  const current = end === 'present' || (!!start && !end && !!pick(e, 'isCurrent', 'current', 'is_current'));
  return {start, end: end === 'present' ? '' : end, current: current || end === 'present'};
}
function strList(v, n = 12) {
  if (!Array.isArray(v)) return [];
  return v.map(x => typeof x === 'string' ? x.trim() : txt(x && (x.name || x.title || x.skill || x.language), 80)).filter(Boolean).slice(0, n);
}
function list(v, fn, n = 15) { return Array.isArray(v) ? v.map(fn).filter(Boolean).slice(0, n) : []; }

function normalizeProfile(p, url) {
  const first = txt(pick(p, 'firstName', 'first_name'), 80), last = txt(pick(p, 'lastName', 'last_name'), 80);
  const name = txt(pick(p, 'fullName', 'full_name', 'name'), 120) || [first, last].filter(Boolean).join(' ');
  const loc = pick(p, 'location', 'addressWithCountry', 'geoLocationName', 'locationName', 'geo');
  const location = typeof loc === 'string' ? txt(loc, 120) : txt(pick(loc || {}, 'linkedinText', 'full', 'text', 'name'), 120);
  const countryCode = txt(pick(p, 'location.countryCode', 'location.parsed.countryCode', 'countryCode', 'country_code', 'geo.countryCode'), 4).toUpperCase();
  const photoRaw = pick(p, 'photo', 'profilePicture', 'profilePic', 'profilePictureUrl', 'pictureUrl', 'profile_pic_url', 'img', 'avatar');
  const photo = typeof photoRaw === 'string' ? photoRaw : txt(pick(photoRaw || {}, 'url', 'src'), 600);

  // Experience: flat list, or grouped by company with nested positions
  const expRaw = pick(p, 'experience', 'experiences', 'positions', 'position', 'workExperience') || [];
  const experience = [];
  (Array.isArray(expRaw) ? expRaw : []).forEach(e => {
    if (!e || typeof e !== 'object') return;
    const company = txt(pick(e, 'companyName', 'company', 'company_name', 'organization', 'companyName.text', 'subtitle'), 120).split(' · ')[0];
    const companyUrl = txt(pick(e, 'companyLinkedinUrl', 'companyUrl', 'company_linkedin_url', 'companyLink', 'company.url'), 300);
    const companyId = txt(pick(e, 'companyId', 'company_id', 'companyUrn', 'company.id'), 60);
    const nested = pick(e, 'positions', 'roles', 'subComponents', 'role_positions');
    if (Array.isArray(nested) && nested.length && !pick(e, 'position', 'title', 'jobTitle')) {
      nested.forEach(n => experience.push({title: txt(pick(n, 'position', 'title', 'jobTitle'), 120), company, companyUrl, companyId, location: txt(pick(n, 'location'), 100), ...range(n), description: txt(pick(n, 'description'), 400)}));
      return;
    }
    experience.push({title: txt(pick(e, 'position', 'title', 'jobTitle', 'role'), 120), company, companyUrl, companyId, location: txt(pick(e, 'location', 'locationName'), 100), ...range(e), description: txt(pick(e, 'description', 'summary'), 400)});
  });

  const education = list(pick(p, 'education', 'educations', 'schools'), e => {
    const school = txt(pick(e, 'schoolName', 'school', 'title', 'institution', 'name'), 140);
    if (!school) return null;
    return {school, degree: txt(pick(e, 'degree', 'degreeName', 'degree_name', 'subtitle'), 140), field: txt(pick(e, 'fieldOfStudy', 'field_of_study', 'field'), 140), ...range(e)};
  });
  const honors = list(pick(p, 'honorsAndAwards', 'honors', 'awards', 'honors_and_awards', 'accomplishmentHonors'), h => {
    const title = txt(typeof h === 'string' ? h : pick(h, 'title', 'name'), 200);
    return title ? {title, issuer: txt(pick(h || {}, 'issuedBy', 'issuer', 'authority', 'subtitle'), 140), date: ym(pick(h || {}, 'issuedAt', 'issueDate', 'date', 'issued_on'))} : null;
  });
  const publications = list(pick(p, 'publications', 'accomplishmentPublications'), x => {
    const title = txt(typeof x === 'string' ? x : pick(x, 'title', 'name'), 240);
    return title ? {title, publisher: txt(pick(x || {}, 'publisher', 'publishedIn', 'subtitle'), 140), date: ym(pick(x || {}, 'publishedAt', 'date', 'publishedOn', 'published_on')), url: txt(pick(x || {}, 'link', 'url'), 400)} : null;
  });
  const certifications = list(pick(p, 'certifications', 'licenseAndCertificates', 'licenses', 'certificates'), x => {
    const title = txt(typeof x === 'string' ? x : pick(x, 'title', 'name'), 200);
    return title ? {title, issuer: txt(pick(x || {}, 'issuedBy', 'authority', 'issuer', 'subtitle'), 140), date: ym(pick(x || {}, 'issuedAt', 'issueDate', 'date'))} : null;
  });
  const patents = list(pick(p, 'patents', 'accomplishmentPatents'), x => {
    const title = txt(typeof x === 'string' ? x : pick(x, 'title', 'name'), 200);
    return title ? {title, number: txt(pick(x || {}, 'number', 'patentNumber'), 60), date: ym(pick(x || {}, 'issuedAt', 'date'))} : null;
  });
  const projects = list(pick(p, 'projects', 'accomplishmentProjects'), x => {
    const title = txt(typeof x === 'string' ? x : pick(x, 'title', 'name'), 200);
    return title ? {title, description: txt(pick(x || {}, 'description'), 300)} : null;
  }, 8);

  const cur = experience.find(e => e.current) || experience[0] || {};
  return {
    url: txt(pick(p, 'linkedinUrl', 'url', 'profileUrl', 'linkedin_url'), 300) || url,
    name,
    headline: txt(pick(p, 'headline', 'occupation', 'jobTitle', 'title'), 240),
    location, countryCode, photo,
    about: txt(pick(p, 'about', 'summary', 'description'), 2000),
    current: {title: cur.title || '', company: cur.company || ''},
    experience: experience.filter(e => e.title || e.company).slice(0, 20),
    education, honors, publications, certifications, patents, projects,
    languages: strList(pick(p, 'languages')),
    skills: strList(pick(p, 'skills', 'topSkills', 'skillsList'), 30),
    fetchedAt: Date.now()
  };
}

/* ---------- Web page title, source and date ---------- */
async function meta(body) {
  let u;
  try { u = new URL(String(body && body.url || '').trim()); } catch (e) { throw fail('bad_url', 400); }
  if (!/^https?:$/.test(u.protocol)) throw fail('bad_url', 400);
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw fail('bad_url', 400);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  let r;
  try {
    r = await fetch(u.toString(), {redirect: 'follow', signal: ctl.signal, headers: {'User-Agent': 'Mozilla/5.0 (compatible; GTCBot/1.0; +https://hylaspart.github.io/gtc-platform/)', 'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-GB,en;q=0.9,ru;q=0.6'}});
  } catch (e) { throw fail('fetch_failed', 502, 'The page could not be opened'); } finally { clearTimeout(timer); }
  const finalUrl = r.url || u.toString();
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const ct = r.headers.get('content-type') || '';
  const out = {url: u.toString(), finalUrl, status: r.status, site: host, title: '', date: '', description: '', image: '', lang: '', contentType: ct.split(';')[0]};
  if (/pdf/i.test(ct)) {
    out.title = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
    return out;
  }
  if (!/html|xml/i.test(ct)) return out;
  const reader = r.body.getReader();
  let html = '', bytes = 0;
  const dec = new TextDecoder();
  while (bytes < 600000) { const {done, value} = await reader.read(); if (done) break; bytes += value.length; html += dec.decode(value, {stream: true}); if (/<\/head>/i.test(html) && bytes > 60000) break; }
  try { reader.cancel(); } catch (e) {}

  const metaTag = (attr, name) => {
    const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${name}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  out.title = (metaTag('property', 'og:title') || metaTag('name', 'twitter:title') || decodeEntities(titleTag)).replace(/\s+/g, ' ').trim().slice(0, 300);
  out.site = (metaTag('property', 'og:site_name') || metaTag('name', 'application-name') || host).slice(0, 120);
  out.description = (metaTag('property', 'og:description') || metaTag('name', 'description')).slice(0, 400);
  out.image = metaTag('property', 'og:image').slice(0, 500);
  out.lang = ((html.match(/<html[^>]*\slang=["']([a-zA-Z-]+)["']/i) || [])[1] || '').toLowerCase();
  let date = metaTag('property', 'article:published_time') || metaTag('property', 'og:published_time') || metaTag('name', 'date') || metaTag('name', 'pubdate')
    || metaTag('name', 'publish-date') || metaTag('name', 'dc.date') || metaTag('name', 'DC.date.issued') || metaTag('itemprop', 'datePublished');
  if (!date) { const m = html.match(/"datePublished"\s*:\s*"([^"]+)"/i); if (m) date = m[1]; }
  if (!date) { const m = html.match(/<time[^>]+datetime=["']([^"']+)["']/i); if (m) date = m[1]; }
  const d = date ? new Date(date) : null;
  out.date = d && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
  return out;
}
function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp|mdash|ndash|laquo|raquo|hellip);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', mdash: '-', ndash: '-', laquo: '"', raquo: '"', hellip: '...'}[k] || m;
  });
}

/* ---------- Optional: Claude for field matching and evidence checks ---------- */
async function ai(body, env) {
  if (!env.ANTHROPIC_API_KEY) throw fail('not_configured', 503, 'ANTHROPIC_API_KEY is not set');
  const prompt = String(body && body.prompt || '').slice(0, 40000);
  if (prompt.length < 20) throw fail('bad_request', 400);
  const model = body.tier === 'quick' ? (env.AI_MODEL_QUICK || 'claude-haiku-5-5') : (env.AI_MODEL_DEFAULT || 'claude-sonnet-5-5');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({model, max_tokens: 1800, messages: [{role: 'user', content: prompt}]})
  });
  if (r.status === 429) throw fail('rate_limited', 429);
  if (!r.ok) throw fail('ai_error', 502, 'Claude API returned ' + r.status);
  const d = await r.json();
  const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw fail('invalid_json', 502);
  return JSON.parse(text.slice(a, b + 1));
}
