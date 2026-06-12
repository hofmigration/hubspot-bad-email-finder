/**
 * bad-email-finder.js
 * ---------------------------------------------------------------
 * Finds CONTACTS created this year whose email looks mistyped
 * (gmail/yahoo/etc. misspellings, .com.com, missing @, no domain dot...)
 * and writes a CSV of: email, client name, contact owner, reason.
 *
 * Skips contacts whose `outcome` = "Deal Lost".
 *
 * READ-ONLY: it never changes a contact. Safe to run anytime.
 * ---------------------------------------------------------------
 */

const TOKEN = process.env.HUBSPOT_TOKEN;
const YEAR  = parseInt(process.env.YEAR || '2026', 10);
const PORTAL = '23735726';
const BASE  = 'https://api.hubapi.com';
const fs    = require('fs');

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
// Real domains we should NOT flag, even if they're close to a popular one.
const KNOWN_GOOD = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','ymail.com','rocketmail.com',
  'hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com','icloud.com','me.com',
  'aol.com','protonmail.com','proton.me','gmx.com','mail.com','email.com','zoho.com',
  'hofmigration.com',
]);
// Popular domains we compare against for "one character off" typos.
const POPULAR = ['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','icloud.com','aol.com','googlemail.com'];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}

function emailProblem(raw) {
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase();
  if (/\s/.test(email)) return 'contains a space';
  const at = email.split('@');
  if (at.length !== 2) return at.length < 2 ? 'missing @' : 'has more than one @';
  const [local, domain] = at;
  if (!local) return 'nothing before the @';
  if (!domain) return 'nothing after the @';
  if (!domain.includes('.')) return `domain "${domain}" has no dot`;
  if (domain.startsWith('.') || domain.endsWith('.')) return `domain "${domain}" starts/ends with a dot`;
  if (domain.includes('..')) return `domain "${domain}" has a double dot`;
  // duplicated ending like .com.com / .net.net
  if (/\.(com|net|org|co)\.(com|net|org|co)$/.test(domain)) return `domain "${domain}" has a doubled ending`;
  // obviously wrong endings
  if (/\.(con|cmo|vom|comm|cm|om|coom|ocm|xom|c0m)$/.test(domain)) return `domain "${domain}" has a bad ending`;
  if (KNOWN_GOOD.has(domain)) return null;
  // one character off a popular provider -> almost always a typo
  for (const p of POPULAR) {
    const dist = levenshtein(domain, p);
    if (dist === 1) return `domain "${domain}" looks like "${p}"`;
  }
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

// ---- Page through contacts, month by month (beats the 10k search cap) ----
async function* contactsForYear(year) {
  for (let m = 0; m < 12; m++) {
    const start = Date.UTC(year, m, 1);
    const end   = Date.UTC(year, m + 1, 1);
    if (start > Date.now()) break;
    let after;
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
      after = data.paging?.next?.after;
      await sleep(200);
    } while (after);
  }
}

(async () => {
  console.log(`Scanning contacts created in ${YEAR} for mistyped emails...`);
  const owners = await loadOwnerNames();

  const rows = [['email','client_name','contact_owner','reason','contact_url']];
  let scanned = 0, skippedLost = 0, flagged = 0;
  const byOwner = {};

  for await (const c of contactsForYear(YEAR)) {
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
      `${BASE.replace('api.hubapi.com','app.hubspot.com')}/contacts/${PORTAL}/record/0-1/${c.id}`,
    ]);
    if (scanned % 2000 === 0) console.log(`  ...scanned ${scanned}, flagged ${flagged}`);
  }

  fs.writeFileSync('bad-emails.csv', rows.map(r => r.join(',')).join('\n'));

  console.log('--------------------------------------------------');
  console.log(`Scanned:            ${scanned}`);
  console.log(`Skipped (Deal Lost):${skippedLost}`);
  console.log(`Flagged bad emails: ${flagged}`);
  console.log('Top owners by flagged emails:');
  Object.entries(byOwner).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .forEach(([o,n]) => console.log(`  ${n.toString().padStart(4)}  ${o}`));
  console.log('Wrote bad-emails.csv');
})().catch(e => { console.error(e); process.exit(1); });
