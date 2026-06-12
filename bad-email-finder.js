/**
 * bad-email-finder.js
 * ---------------------------------------------------------------
 * Finds CONTACTS created in a date range whose email looks mistyped
 * (provider misspellings incl. swapped letters, .com.com, bad TLDs,
 * missing @, no domain dot, dot mistakes...) and writes a CSV of:
 * email, client name, contact owner, reason.
 *
 * Skips contacts whose `outcome` = "Deal Lost".
 *
 * READ-ONLY: it never changes a contact. Safe to run anytime.
 *
 * START env = "YYYY-MM" first month to scan (default 2025-08).
 * Scans from START through the current month.
 * ---------------------------------------------------------------
 */

const TOKEN  = process.env.HUBSPOT_TOKEN;
const START  = process.env.START || '2025-08';   // YYYY-MM
const PORTAL = '23735726';
const BASE   = 'https://api.hubapi.com';
const fs     = require('fs');

if (!TOKEN) { console.error('Missing HUBSPOT_TOKEN secret.'); process.exit(1); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function hs(path, options = {}, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(BASE + path, {
      ...options,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${res.status} on ${path}: ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }
  throw new Error(`Gave up after retries on ${path}`);
}

// ---- Email typo detection ------------------------------------------------
// Real domains we should NOT flag, even if close to a popular one.
const KNOWN_GOOD = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','ymail.com','rocketmail.com',
  'hotmail.com','hotmail.co.uk','outlook.com','outlook.co.uk','live.com','live.co.uk','msn.com',
  'icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me','gmx.com','gmx.net',
  'mail.com','email.com','zoho.com','yandex.com','rediffmail.com','comcast.net','sbcglobal.net',
  'btinternet.com','hofmigration.com',
]);
// Popular domains we compare against for near-miss typos.
const POPULAR = ['gmail.com','googlemail.com','yahoo.com','hotmail.com','outlook.com','live.com','icloud.com','aol.com','msn.com'];
// Clearly-wrong TLD endings (alphabetic but not real). We deliberately leave
// .cm/.om/.co out (real ccTLDs) - those get caught by the provider near-miss.
const BAD_TLDS = new Set(['con','cone','cpm','clm','cmo','vom','xom','comm','ccom','coom','ocm','cim','cobm','copm','net2','ner','nte','nett','ogr','orgg','rog','edy','gpv']);

// Damerau-Levenshtein: like edit distance, but a swap of two adjacent
// letters counts as 1 (so "gmial" -> "gmail" is distance 1).
function damerau(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + cost);
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1])
        d[i][j] = Math.min(d[i][j], d[i-2][j-2] + 1);
    }
  }
  return d[m][n];
}

function emailProblem(raw) {
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase();
  if (/\s/.test(email)) return 'contains a space';
  if (/[,;]/.test(email)) return 'contains a comma/semicolon';
  const at = email.split('@');
  if (at.length !== 2) return at.length < 2 ? 'missing @' : 'has more than one @';
  const [local, domain] = at;

  if (!local) return 'nothing before the @';
  if (local.startsWith('.') || local.endsWith('.')) return 'name before @ starts/ends with a dot';
  if (local.includes('..')) return 'name before @ has a double dot';

  if (!domain) return 'nothing after the @';
  if (!domain.includes('.')) return `domain "${domain}" has no dot`;
  if (domain.startsWith('.') || domain.endsWith('.')) return `domain "${domain}" starts/ends with a dot`;
  if (domain.includes('..')) return `domain "${domain}" has a double dot`;
  if (/\.(com|net|org|edu|gov|co|info)\.(com|net|org|edu|gov|co|info)$/.test(domain)) return `domain "${domain}" has a doubled ending`;

  const tld = domain.split('.').pop();
  if (!/^[a-z]{2,}$/.test(tld)) return `domain "${domain}" has a bad ending ".${tld}"`;
  if (BAD_TLDS.has(tld)) return `domain "${domain}" has a misspelled ending ".${tld}"`;

  if (KNOWN_GOOD.has(domain)) return null;

  // Near-miss to a popular provider.
  let best = null, bestDist = 99;
  for (const p of POPULAR) {
    const dist = damerau(domain, p);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  if (bestDist === 1) return `domain "${domain}" looks like a typo of "${best}"`;
  if (bestDist === 2) return `domain "${domain}" might be a typo of "${best}" (please double-check)`;

  return null;
}

// ---- Owner name lookup ---------------------------------------------------
async function loadOwnerNames() {
  const map = {};
  for (const arch of ['false', 'true']) {
    let after;
    do {
      const q = `?limit=100&archived=${arch}` + (after ? `&after=${after}` : '');
      const data = await hs(`/crm/v3/owners${q}`);
      for (const o of (data.results || [])) {
        const name = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || String(o.id);
        if (o.id)     map[String(o.id)]     = name;
        if (o.userId) map[String(o.userId)] = name;
      }
      after = data.paging?.next?.after;
      await sleep(120);
    } while (after);
  }
  return map;
}

// ---- Month iterator from START (YYYY-MM) through current month -----------
function* monthWindows(startStr) {
  const [sy, sm] = startStr.split('-').map(Number);
  let y = sy, m = sm - 1; // JS months 0-based
  const now = new Date();
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth())) {
    yield [Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1), `${y}-${String(m+1).padStart(2,'0')}`];
    m++; if (m > 11) { m = 0; y++; }
  }
}

async function* contacts() {
  for (const [start, end, label] of monthWindows(START)) {
    let after, monthCount = 0;
    do {
      const body = {
        filterGroups: [{ filters: [
          { propertyName: 'createdate', operator: 'GTE', value: String(start) },
          { propertyName: 'createdate', operator: 'LT',  value: String(end) },
          { propertyName: 'email',      operator: 'HAS_PROPERTY' },
        ]}],
        properties: ['email','firstname','lastname','hubspot_owner_id','outcome'],
        limit: 100,
        ...(after ? { after } : {}),
      };
      const data = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body: JSON.stringify(body) });
      for (const c of (data.results || [])) yield c;
      monthCount += (data.results || []).length;
      after = data.paging?.next?.after;
      await sleep(200);
    } while (after);
    console.log(`  ${label}: ${monthCount} contacts`);
  }
}

(async () => {
  console.log(`Scanning contacts created from ${START} to now for mistyped emails...`);
  const owners = await loadOwnerNames();

  const rows = [['email','client_name','contact_owner','reason','contact_url']];
  let scanned = 0, skippedLost = 0, flagged = 0;
  const byOwner = {};

  for await (const c of contacts()) {
    scanned++;
    const p = c.properties || {};
    if (p.outcome === 'Deal Lost') { skippedLost++; continue; }
    const reason = emailProblem(p.email);
    if (!reason) continue;

    flagged++;
    const name  = `${p.firstname || ''} ${p.lastname || ''}`.trim() || '(no name)';
    const owner = owners[String(p.hubspot_owner_id)] || (p.hubspot_owner_id ? `id:${p.hubspot_owner_id}` : '(no owner)');
    byOwner[owner] = (byOwner[owner] || 0) + 1;
    rows.push([
      p.email,
      `"${name.replace(/"/g,'""')}"`,
      `"${owner.replace(/"/g,'""')}"`,
      `"${reason.replace(/"/g,'""')}"`,
      `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/${c.id}`,
    ]);
  }

  fs.writeFileSync('bad-emails.csv', rows.map(r => r.join(',')).join('\n'));

  console.log('--------------------------------------------------');
  console.log(`Scanned:             ${scanned}`);
  console.log(`Skipped (Deal Lost): ${skippedLost}`);
  console.log(`Flagged bad emails:  ${flagged}`);
  console.log('Top owners by flagged emails:');
  Object.entries(byOwner).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .forEach(([o,n]) => console.log(`  ${String(n).padStart(4)}  ${o}`));
  console.log('Wrote bad-emails.csv');
})().catch(e => { console.error(e); process.exit(1); });
