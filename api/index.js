// PayParity — EU Pay Transparency Directive readiness for mid-size employers
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/payparity-data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'payparity.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS workspaces (slug TEXT PRIMARY KEY, company TEXT NOT NULL, headcount TEXT DEFAULT '150-249', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS bands (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, role TEXT NOT NULL, level TEXT DEFAULT '', min INTEGER NOT NULL, mid INTEGER NOT NULL, max INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, role TEXT NOT NULL, level TEXT DEFAULT '', gender TEXT NOT NULL, salary INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, item INTEGER NOT NULL, done INTEGER DEFAULT 0, UNIQUE(ws, item));
`);

const OBLIGATIONS = {
  '250+': { label: '250+ employees', report: 'First gender pay-gap report due 7 June 2027, then annually', freq: 'annual' },
  '150-249': { label: '150–249 employees', report: 'First gender pay-gap report due 7 June 2027, then every 3 years', freq: 'every 3 years' },
  '100-149': { label: '100–149 employees', report: 'First gender pay-gap report due 7 June 2031, then every 3 years', freq: 'every 3 years' },
  '<100': { label: 'Under 100 employees', report: 'No reporting duty, but transparency rights & job-ad rules still apply', freq: '—' },
};
const CHECKLIST = [
  'Pay ranges (or band) included in every job advert / before interview',
  'Salary-history questions removed from interviews and application forms',
  'Objective, gender-neutral criteria for pay and progression documented',
  'Process to answer employee pay-information requests within 2 months',
  'Job architecture: roles mapped to levels for "equal value" comparison',
  'Payroll data pipeline for the gender pay-gap report tested end-to-end',
  'Plan for a joint pay assessment if any category gap ≥5% is unjustified',
];

const q = {
  ws: db.prepare('SELECT * FROM workspaces WHERE slug=?'),
  newWs: db.prepare('INSERT INTO workspaces (slug, company, headcount) VALUES (?,?,?)'),
  bands: db.prepare('SELECT * FROM bands WHERE ws=? ORDER BY role, level'),
  addBand: db.prepare('INSERT INTO bands (ws, role, level, min, mid, max) VALUES (?,?,?,?,?,?)'),
  people: db.prepare('SELECT * FROM people WHERE ws=? ORDER BY role, level'),
  addPerson: db.prepare('INSERT INTO people (ws, role, level, gender, salary) VALUES (?,?,?,?,?)'),
  clearPeople: db.prepare('DELETE FROM people WHERE ws=?'),
  tick: db.prepare('INSERT INTO ticks (ws, item, done) VALUES (?,?,1) ON CONFLICT(ws,item) DO UPDATE SET done=1-done'),
  ticks: db.prepare('SELECT item, done FROM ticks WHERE ws=?'),
};

function seed() {
  if (q.ws.get('demo')) return;
  q.newWs.run('demo', 'Helvetia Software AG', '150-249');
  q.addBand.run('demo', 'Software Engineer', 'L2', 62000, 72000, 82000);
  q.addBand.run('demo', 'Software Engineer', 'L3', 78000, 92000, 105000);
  q.addBand.run('demo', 'Account Executive', 'L2', 55000, 66000, 78000);
  const P = [
    ['Software Engineer','L2','M',74000],['Software Engineer','L2','F',69000],['Software Engineer','L2','M',71000],['Software Engineer','L2','F',70500],
    ['Software Engineer','L3','M',98000],['Software Engineer','L3','M',95000],['Software Engineer','L3','F',88000],['Software Engineer','L3','F',86500],
    ['Account Executive','L2','F',64000],['Account Executive','L2','M',72000],['Account Executive','L2','M',70000],['Account Executive','L2','F',63000],
  ];
  for (const [r, l, g, s] of P) q.addPerson.run('demo', r, l, g, s);
  for (const i of [0, 2]) q.tick.run('demo', i);
}
seed();

function analyze(people) {
  const by = {};
  for (const p of people) {
    const k = `${p.role} · ${p.level}`;
    (by[k] = by[k] || []).push(p);
  }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
  const rows = Object.entries(by).map(([k, ps]) => {
    const m = ps.filter(p => p.gender === 'M').map(p => p.salary);
    const f = ps.filter(p => p.gender === 'F').map(p => p.salary);
    const gap = m.length && f.length ? (mean(m) - mean(f)) / mean(m) * 100 : null;
    return { k, n: ps.length, nm: m.length, nf: f.length, meanM: mean(m), meanF: mean(f), gap };
  });
  const allM = people.filter(p => p.gender === 'M').map(p => p.salary);
  const allF = people.filter(p => p.gender === 'F').map(p => p.salary);
  const overall = allM.length && allF.length ? (mean(allM) - mean(allF)) / mean(allM) * 100 : null;
  const overallMedian = allM.length && allF.length ? (median(allM) - median(allF)) / median(allM) * 100 : null;
  return { rows, overall, overallMedian, triggers: rows.filter(r => r.gap !== null && Math.abs(r.gap) >= 5) };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur = n => '€' + Math.round(n).toLocaleString('en-IE');
const CSS = `
:root{--bg:#faf7f9;--panel:#fff;--line:#e9dde5;--ink:#2a1620;--dim:#7c6470;--plum:#8e2f5c;--plum-dark:#571836;--soft:#f7e4ee;--green:#1e8e5a;--green-soft:#e2f5eb;--red:#c0392b;--red-soft:#fae7e4;--amber:#b7791f;--amber-soft:#fbf1dc;--font:"Avenir Next","Segoe UI",-apple-system,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);line-height:1.55}
a{color:var(--plum);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1020px;margin:0 auto;padding:0 22px}
nav{background:var(--plum-dark);color:#fff}nav .wrap{display:flex;align-items:center;gap:22px;height:60px}
.logo{font-weight:800;font-size:1.15rem;color:#fff;display:flex;align-items:center;gap:9px}.logo:hover{text-decoration:none}
.mark{width:25px;height:25px;border-radius:50%;background:#f2a7c9;color:var(--plum-dark);display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:.8rem}
nav a.nl{color:#eec3d7}.spacer{flex:1}
.btn{display:inline-block;background:var(--plum);color:#fff;font-weight:700;padding:10px 18px;border-radius:8px;border:none;font-size:.95rem;cursor:pointer;font-family:var(--font)}
.btn:hover{filter:brightness(1.1);text-decoration:none}.btn.ghost{background:transparent;border:1.5px solid var(--line);color:var(--ink)}nav .btn.ghost{color:#fff;border-color:#7c3e5c}.btn.small{padding:6px 12px;font-size:.85rem}
.hero{background:linear-gradient(160deg,var(--plum-dark),#8e2f5c 145%);color:#fff;padding:76px 0 64px}
.hero h1{font-size:2.7rem;line-height:1.12;letter-spacing:-.02em;margin:0 0 16px;max-width:700px}.hero h1 em{font-style:normal;color:#f2a7c9}
.hero p{color:#eec3d7;font-size:1.13rem;max-width:620px;margin:0 0 26px}
.statrow{display:flex;gap:40px;flex-wrap:wrap;margin-top:34px}.statrow b{display:block;font-size:1.5rem;color:#f2a7c9}.statrow span{color:#eec3d7;font-size:.87rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:18px}.panel h3{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-top:24px}
.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:700;color:var(--plum);margin:38px 0 6px}
h2.t{font-size:1.7rem;margin:0 0 10px;letter-spacing:-.01em}
input,select,textarea{width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:.95rem;font-family:var(--font);background:#fff;color:var(--ink)}
textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--plum)}
label.f{display:block;font-weight:700;font-size:.85rem;margin:12px 0 5px;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;color:var(--dim);font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1.5px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line)}
.tag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.75rem;font-weight:700}
.tag.green{background:var(--green-soft);color:var(--green)}.tag.red{background:var(--red-soft);color:var(--red)}.tag.amber{background:var(--amber-soft);color:var(--amber)}.tag.plum{background:var(--soft);color:var(--plum)}.tag.dim{background:#f2ebef;color:var(--dim)}
.big{font-size:2.2rem;font-weight:800}
.check{display:flex;gap:10px;align-items:flex-start;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 13px;font-size:.9rem;margin-top:8px}
.footer{color:var(--dim);font-size:.85rem;border-top:1px solid var(--line);margin-top:70px;padding:30px 0}
pre.doc{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:18px;white-space:pre-wrap;font-family:var(--font);font-size:.9rem;line-height:1.6}
@media(max-width:640px){.hero h1{font-size:2rem}}`;
const page = (title, body, ws) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="PayParity — EU Pay Transparency Directive readiness for mid-size employers: pay bands, gender gap analysis, the 5% tripwire, job-ad ranges, and your first-report countdown.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='11' fill='%23571836'/><path d='M7 15v-4m5 4V7m5 8v-6' stroke='%23f2a7c9' stroke-width='2.6' stroke-linecap='round'/></svg>">
<style>${CSS}</style></head><body>
<nav><div class="wrap"><a class="logo" href="/"><span class="mark">⚖</span>PayParity</a>
${ws ? `<a class="nl" href="/w/${esc(ws)}">Workspace</a>` : ''}
<div class="spacer"></div><a class="nl" href="/whitepaper">Whitepaper</a><a class="btn ghost small" href="/#start">New workspace</a></div></nav>
${body}
<div class="footer"><div class="wrap"><b style="color:var(--ink)">PayParity</b> — ready before your first report is due. Demo deployment: use example data, not real employee data; informational only, not legal advice; data may reset periodically. <a href="/w/demo">Explore the demo →</a></div></div></body></html>`;

const app = express();
app.use(express.urlencoded({ extended: true, limit: '300kb' }));

app.get('/', (req, res) => res.send(page('PayParity — EU Pay Transparency readiness', `
<div class="hero"><div class="wrap">
<h1>Pay transparency is law now.<br><em>Your first report is due June 2027.</em></h1>
<p>The EU Pay Transparency Directive was transposed June 7, 2026: pay ranges in every job ad, no salary-history questions, employees entitled to pay data — and gender pay-gap reports with a 5% tripwire that triggers a joint pay assessment. Enterprises bought consultants. PayParity is for the 100–500-person companies that got homework instead of headcount.</p>
<a class="btn" href="#start" style="background:#f2a7c9;color:#571836">Check my readiness</a> &nbsp; <a class="btn ghost" href="/w/demo" style="color:#fff">See live demo</a>
<div class="statrow">
<div><b>Jun 2026</b><span>directive in force across the EU</span></div>
<div><b>Jun 2027</b><span>first reports for 150+ employers</span></div>
<div><b>5%</b><span>unjustified gap → mandatory joint pay assessment</span></div>
</div></div></div>
<div class="wrap">
<div class="kicker">How it works</div><h2 class="t">From payroll export to defensible in an afternoon</h2>
<div class="grid">
<div class="panel"><h3>1 · Build your bands</h3><p style="color:var(--dim)">Role × level pay bands — the backbone of "objective, gender-neutral criteria" and instant job-ad ranges.</p></div>
<div class="panel"><h3>2 · Paste, don't integrate</h3><p style="color:var(--dim)">Paste anonymized rows (role, level, gender, salary). PayParity computes mean & median gaps overall and per category — and flags every 5% tripwire.</p></div>
<div class="panel"><h3>3 · Close the gaps</h3><p style="color:var(--dim)">A seven-point readiness checklist tracks you to report day: ad ranges, history-question ban, request process, data pipeline.</p></div>
</div>
<div class="kicker" id="start">Start now</div><h2 class="t">Create your workspace</h2>
<div class="panel" style="max-width:500px">
<form method="post" action="/workspaces">
<label class="f">Company name</label><input name="company" required maxlength="80" placeholder="Helvetia Software AG">
<label class="f">EU headcount</label><select name="headcount">${Object.entries(OBLIGATIONS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join('')}</select>
<p style="color:var(--dim);font-size:.85rem">Private link, no signup. Use anonymized example data in this demo. Free in beta; €89/mo after.</p>
<button class="btn">Create workspace</button></form></div></div>`)));

app.post('/workspaces', (req, res) => {
  const company = (req.body.company || '').trim().slice(0, 80);
  if (!company) return res.redirect('/');
  const slug = crypto.randomBytes(5).toString('hex');
  q.newWs.run(slug, company, OBLIGATIONS[req.body.headcount] ? req.body.headcount : '150-249');
  res.redirect(`/w/${slug}`);
});

function loadWs(req, res, next) {
  req.ws = q.ws.get(req.params.slug);
  if (!req.ws) return res.status(404).send(page('Not found', `<div class="wrap" style="padding-top:40px"><div class="panel">Workspace not found. <a href="/">Home</a></div></div>`));
  next();
}

app.get('/w/:slug', loadWs, (req, res) => {
  const bands = q.bands.all(req.ws.slug);
  const people = q.people.all(req.ws.slug);
  const a = analyze(people);
  const ticks = Object.fromEntries(q.ticks.all(req.ws.slug).map(t => [t.item, t.done]));
  const doneCount = CHECKLIST.filter((_, i) => ticks[i]).length;
  const ob = OBLIGATIONS[req.ws.headcount];
  res.send(page(`${req.ws.company} · PayParity`, `
<div class="wrap" style="padding-top:36px">
<div class="kicker">Pay-transparency workspace</div><h2 class="t">${esc(req.ws.company)}</h2>
<p style="color:var(--dim)">${ob.label} · <b style="color:var(--ink)">${ob.report}</b> · Private link: <code>/w/${esc(req.ws.slug)}</code></p>
<div class="panel"><h3>Gender pay-gap snapshot ${people.length ? `<span style="color:var(--dim);font-weight:400;font-size:.85rem">— ${people.length} rows analyzed</span>` : ''}</h3>
${people.length ? `
<div style="display:flex;gap:36px;flex-wrap:wrap;align-items:center">
<div><div style="color:var(--dim);font-size:.85rem">Overall mean gap</div><div class="big" style="color:${a.overall !== null && Math.abs(a.overall) >= 5 ? 'var(--red)' : 'var(--green)'}">${a.overall === null ? '—' : a.overall.toFixed(1) + '%'}</div></div>
<div><div style="color:var(--dim);font-size:.85rem">Overall median gap</div><div class="big" style="color:${a.overallMedian !== null && Math.abs(a.overallMedian) >= 5 ? 'var(--red)' : 'var(--green)'}">${a.overallMedian === null ? '—' : a.overallMedian.toFixed(1) + '%'}</div></div>
<div style="flex:1;min-width:240px;color:var(--dim);font-size:.92rem">${a.triggers.length ? `<span class="tag red">⚠ ${a.triggers.length} categor${a.triggers.length === 1 ? 'y' : 'ies'} at/over the 5% tripwire</span><br>Where a category gap of ≥5% can't be justified by objective criteria and isn't remedied within 6 months, the directive requires a <b>joint pay assessment</b> with workers' representatives.` : '<span class="tag green">No category at the 5% tripwire</span><br>Keep bands and criteria documented to stay defensible.'}</div></div>
<table style="margin-top:14px"><tr><th>Category</th><th>n (M/F)</th><th>Mean M</th><th>Mean F</th><th>Gap</th></tr>
${a.rows.map(r => `<tr><td><b>${esc(r.k)}</b></td><td style="color:var(--dim)">${r.nm}/${r.nf}</td><td>${eur(r.meanM)}</td><td>${eur(r.meanF)}</td>
<td>${r.gap === null ? '<span class="tag dim">n/a</span>' : `<span class="tag ${Math.abs(r.gap) >= 5 ? 'red' : 'green'}">${r.gap.toFixed(1)}%</span>`}</td></tr>`).join('')}</table>` : '<p style="color:var(--dim)">No data yet — paste rows below.</p>'}
<form method="post" action="/w/${esc(req.ws.slug)}/people" style="margin-top:16px">
<label class="f">Paste rows — one per line: role, level, gender (M/F), annual salary <span style="font-weight:400">(replaces current data; use anonymized examples in the demo)</span></label>
<textarea name="rows" placeholder="Software Engineer, L2, F, 69000&#10;Software Engineer, L2, M, 74000"></textarea>
<button class="btn" style="margin-top:10px">Analyze</button></form></div>
<div class="panel"><h3>Pay bands & job-ad ranges</h3>
${bands.length ? `<table><tr><th>Role</th><th>Level</th><th>Band</th><th>Job-ad snippet (directive-ready)</th></tr>
${bands.map(b => `<tr><td><b>${esc(b.role)}</b></td><td>${esc(b.level)}</td><td>${eur(b.min)} – ${eur(b.max)}</td>
<td style="color:var(--dim);font-size:.85rem">"Salary range for this position: ${eur(b.min)}–${eur(b.max)} gross/year, based on experience against published criteria."</td></tr>`).join('')}</table>` : '<p style="color:var(--dim)">No bands yet.</p>'}
<form method="post" action="/w/${esc(req.ws.slug)}/bands" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:flex-end">
<div style="flex:1;min-width:150px"><label class="f">Role</label><input name="role" required></div>
<div style="width:90px"><label class="f">Level</label><input name="level" placeholder="L2"></div>
<div style="width:110px"><label class="f">Min €</label><input name="min" type="number" required></div>
<div style="width:110px"><label class="f">Mid €</label><input name="mid" type="number" required></div>
<div style="width:110px"><label class="f">Max €</label><input name="max" type="number" required></div>
<button class="btn">Add band</button></form></div>
<div class="panel"><h3>Readiness checklist <span style="color:var(--dim);font-weight:400;font-size:.85rem">— ${doneCount}/${CHECKLIST.length} complete</span></h3>
${CHECKLIST.map((c, i) => `<form method="post" action="/w/${esc(req.ws.slug)}/tick" class="check">
<input type="hidden" name="item" value="${i}">
<button class="btn small ${ticks[i] ? '' : 'ghost'}" style="min-width:44px">${ticks[i] ? '✓' : '☐'}</button>
<span style="${ticks[i] ? 'color:var(--dim);text-decoration:line-through' : ''}">${c}</span></form>`).join('')}
</div>
</div>`, req.ws.slug));
});

app.post('/w/:slug/people', loadWs, (req, res) => {
  const lines = (req.body.rows || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2000);
  const parsed = [];
  for (const line of lines) {
    const parts = line.split(/[,;\t]/).map(s => s.trim());
    if (parts.length < 4) continue;
    const salary = parseInt(parts[parts.length - 1].replace(/[^\d]/g, ''), 10);
    const gender = parts[parts.length - 2].toUpperCase().startsWith('F') ? 'F' : parts[parts.length - 2].toUpperCase().startsWith('M') ? 'M' : null;
    const level = parts.length >= 4 ? parts[parts.length - 3] : '';
    const role = parts.slice(0, parts.length - 3).join(', ') || parts[0];
    if (role && gender && salary > 0) parsed.push([role.slice(0, 60), level.slice(0, 20), gender, Math.min(salary, 10000000)]);
  }
  if (parsed.length) {
    q.clearPeople.run(req.ws.slug);
    for (const [r, l, g, s] of parsed) q.addPerson.run(req.ws.slug, r, l, g, s);
  }
  res.redirect(`/w/${req.ws.slug}`);
});
app.post('/w/:slug/bands', loadWs, (req, res) => {
  const { role, level, min, mid, max } = req.body;
  const [a, b, c] = [parseInt(min), parseInt(mid), parseInt(max)];
  if (role && a > 0 && b >= a && c >= b) q.addBand.run(req.ws.slug, role.slice(0, 60), (level || '').slice(0, 20), a, b, c);
  res.redirect(`/w/${req.ws.slug}`);
});
app.post('/w/:slug/tick', loadWs, (req, res) => {
  const i = Number(req.body.item);
  if (i >= 0 && i < CHECKLIST.length) q.tick.run(req.ws.slug, i);
  res.redirect(`/w/${req.ws.slug}`);
});

const WHITEPAPER = `PAYPARITY — WHITEPAPER
Pay-transparency readiness for the mid-market · July 2026

THE PROBLEM
The EU Pay Transparency Directive (2023/970) reached its transposition deadline on 7 June 2026. From now on, employers across the EU must publish pay ranges (or bands) to candidates, may no longer ask salary history, must answer employees' pay-information requests within two months, and must document objective, gender-neutral criteria for pay and progression. Employers with 150+ employees file their first gender pay-gap reports by 7 June 2027 (100–149 by 2031) — and any category gap of 5%+ that can't be justified and isn't remedied triggers a mandatory joint pay assessment with workers' representatives.
Enterprises are handing this to comp consultants and enterprise platforms (beqom, Ravio, Figures, ADP). The 100–500-employee company — which has an HR team of two and payroll in a spreadsheet — has obligations nearly as heavy and tooling that assumes a compensation department.

THE SOLUTION
PayParity is the mid-market kit: (1) pay-band builder that doubles as a job-ad range generator (the directive obligation recruiters hit first); (2) paste-based gap analysis — no HRIS integration; anonymized role/level/gender/salary rows produce mean & median gaps overall and per category, with every ≥5% category flagged against the joint-assessment tripwire; (3) a seven-point readiness checklist from history-question ban to report-pipeline test, tracked to your exact first-report date by headcount band. Production adds HRIS import, multi-entity/country transposition nuances, remediation planning, and report-format exports per member state.

WHY NOW
The compliance clock started in June 2026 and the first hard artifact (the 2027 report) is close enough to budget for but far enough to fix gaps — the perfect anxiety window. Every job ad an employer posts without a range is now a visible compliance failure competitors and candidates notice.

MARKET
~200,000 EU companies have 100+ employees. At €89–€249/mo, the direct mid-market is a €200M+ ARR pool, with channel leverage through payroll bureaus and employment-law firms. Non-EU employers with EU entities (US/UK scale-ups) are a high-intent segment discovering the obligation late.

BUSINESS MODEL
€89/mo core (bands, gap analysis, checklist), €249/mo plus (multi-entity, member-state report exports, remediation tracking). Channels: payroll providers, employment counsel, HR communities.

SOURCES
- Council of the EU: pay transparency policy — consilium.europa.eu/en/policies/pay-transparency/
- Mayer Brown (Jul 2026): practical briefing for international employers — mayerbrown.com/en/insights/publications/2026/07/eu-pay-transparency-directive-practical-briefing-for-international-employers
- Ravio (2026): complete guide for employers — ravio.com/blog/everything-you-need-to-know-about-the-eu-pay-transparency-directive
Member states transpose with local variations — verify specifics with counsel. PayParity is informational, not legal advice.`;

app.get('/whitepaper', (req, res) => res.send(page('Whitepaper · PayParity', `<div class="wrap" style="padding-top:36px;max-width:760px"><div class="panel"><pre class="doc">${esc(WHITEPAPER)}</pre></div></div>`)));
app.use((req, res) => res.status(404).send(page('Not found', `<div class="wrap" style="padding-top:60px"><div class="panel">Page not found. <a href="/">Home</a></div></div>`)));

if (require.main === module) app.listen(process.env.PORT || 3022, () => console.log('PayParity on :' + (process.env.PORT || 3022)));
module.exports = app;
