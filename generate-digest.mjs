// generate-digest.mjs  (v2: multi-subspecialty)
// Weekly orthopaedic research digest generator.
// Pure Node.js 20+ (uses the built-in fetch; no external packages to install).
//
// It produces ONE digest file per subspecialty in a single run:
//   docs/digest.json       (shoulder & elbow, name kept for the existing live page)
//   docs/hip-knee.json
//   docs/foot-ankle.json
//   docs/trauma.json
//   docs/paeds.json
//
// For each subspecialty it takes every recent paper from that field's specialty
// journals, and the shoulder/hip/etc. papers from the shared general journals.
// Factual fields (title, authors, journal, date, link) come from PubMed; only the
// summary fields are written by Claude, from each paper's abstract.
//
// Environment variables (only ANTHROPIC_API_KEY is required):
//   ANTHROPIC_API_KEY  (required)  supplied by the GitHub Actions secret
//   ANTHROPIC_MODEL    default 'claude-haiku-4-5-20251001' (cheapest; see notes)
//   WINDOW_DAYS        default 7   how far back to look (set 30 to sweep monthly journals)
//   PUBMED_DATETYPE    default 'edat' ('edat' = added to PubMed; 'pdat' = publication date)
//   MAX_ARTICLES       default 0   per-subspecialty cap (0 = no limit; set a number to cap cost)
//   ONLY               optional, comma-separated keys to run a subset, e.g. "hip-knee,trauma"
//   NCBI_API_KEY       optional, raises the PubMed rate limit (free from NCBI)
//   NCBI_EMAIL         optional, polite identifier for NCBI
//
// Model note: model names and prices change. Check https://docs.claude.com before
// changing ANTHROPIC_MODEL. Haiku is cheapest; claude-sonnet-4-6 is higher quality.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONFIG = {
  windowDays:   Number(process.env.WINDOW_DAYS || 7),
  dateType:     process.env.PUBMED_DATETYPE || 'edat',
  model:        process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  maxArticles:  Number(process.env.MAX_ARTICLES || 0),
  only:         (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean),
  ncbiKey:      process.env.NCBI_API_KEY || '',
  email:        process.env.NCBI_EMAIL || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
};

// Shared general journals: included in every subspecialty, filtered to that field.
const GENERAL_JOURNALS = [
  { display: 'BJJ',               ta: 'Bone Joint J' },
  { display: 'JBJS',              ta: 'J Bone Joint Surg Am' },
  { display: 'Bone & Joint Open', ta: 'Bone Jt Open' },
  { display: 'Acta Orthopaedica', ta: 'Acta Orthop' },
  { display: 'Lancet',            ta: 'Lancet' },
  { display: 'BMJ',               ta: 'BMJ' },
  { display: 'NEJM',              ta: 'N Engl J Med' },
];

// Each subspecialty: its specialty journals (taken whole), a keyword filter applied
// to the general journals, and its output file. Edit these freely; a wrong journal
// abbreviation simply means that journal returns nothing, never wrong content.
const SUBSPECIALTIES = [
  {
    key: 'shoulder-elbow',
    out: 'docs/digest.json',
    specialty: [
      { display: 'JSES',             ta: 'J Shoulder Elbow Surg' },
      { display: 'Shoulder & Elbow', ta: 'Shoulder Elbow' },
    ],
    filter: '(shoulder[tiab] OR "rotator cuff"[tiab] OR glenohumeral[tiab] OR elbow[tiab] OR ' +
            'clavicle[tiab] OR "proximal humerus"[tiab] OR humeral[tiab] OR scapula*[tiab] OR ' +
            'acromioclavicular[tiab] OR "distal biceps"[tiab] OR epicondylitis[tiab])',
  },
  {
    key: 'hip-knee',
    out: 'docs/hip-knee.json',
    specialty: [
      { display: 'J Arthroplasty', ta: 'J Arthroplasty' },
      { display: 'KSSTA',          ta: 'Knee Surg Sports Traumatol Arthrosc' },
      { display: 'The Knee',       ta: 'Knee' },
      { display: 'Hip Int',        ta: 'Hip Int' },
    ],
    filter: '(hip[tiab] OR knee[tiab] OR arthroplasty[tiab] OR "total hip"[tiab] OR "total knee"[tiab] OR ' +
            'acetabul*[tiab] OR femoroacetabular[tiab] OR "anterior cruciate"[tiab] OR meniscus[tiab] OR ' +
            'patell*[tiab] OR unicompartmental[tiab] OR periprosthetic[tiab])',
  },
  {
    key: 'foot-ankle',
    out: 'docs/foot-ankle.json',
    specialty: [
      { display: 'Foot & Ankle Int', ta: 'Foot Ankle Int' },
      { display: 'Foot Ankle Surg',  ta: 'Foot Ankle Surg' },
    ],
    filter: '(foot[tiab] OR ankle[tiab] OR hallux[tiab] OR bunion[tiab] OR calcaneal[tiab] OR calcaneus[tiab] OR ' +
            'achilles[tiab] OR hindfoot[tiab] OR midfoot[tiab] OR metatarsal[tiab] OR flatfoot[tiab] OR ' +
            'syndesmosis[tiab] OR pilon[tiab])',
  },
  {
    key: 'trauma',
    out: 'docs/trauma.json',
    specialty: [
      { display: 'J Orthop Trauma', ta: 'J Orthop Trauma' },
      { display: 'Injury',          ta: 'Injury' },
      { display: 'OTA Int',         ta: 'OTA Int' },
    ],
    filter: '(fracture*[tiab] OR nonunion[tiab] OR malunion[tiab] OR "internal fixation"[tiab] OR ' +
            'intramedullary[tiab] OR osteosynthesis[tiab] OR polytrauma[tiab] OR "open fracture"[tiab] OR ' +
            'dislocation[tiab])',
  },
  {
    key: 'paeds',
    out: 'docs/paeds.json',
    specialty: [
      { display: 'J Pediatr Orthop',   ta: 'J Pediatr Orthop' },
      { display: 'J Child Orthop',     ta: 'J Child Orthop' },
      { display: 'J Pediatr Orthop B', ta: 'J Pediatr Orthop B' },
    ],
    filter: '(paediatric[tiab] OR pediatric[tiab] OR child*[tiab] OR adolescent[tiab] OR ' +
            '"developmental dysplasia"[tiab] OR DDH[tiab] OR Perthes[tiab] OR "slipped capital femoral"[tiab] OR ' +
            'SCFE[tiab] OR clubfoot[tiab] OR scoliosis[tiab])',
  },
];

const SKIP_PUB_TYPES = new Set([
  'Published Erratum', 'Comment', 'Editorial', 'Letter', 'News',
  'Retraction of Publication', 'Retracted Publication', 'Biography', 'Obituary',
]);

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRetry(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

function withKeys(params) {
  if (CONFIG.ncbiKey) params.set('api_key', CONFIG.ncbiKey);
  if (CONFIG.email) params.set('email', CONFIG.email);
  return params;
}

async function esearch(ta, filter) {
  const term = filter ? `"${ta}"[ta] AND ${filter}` : `"${ta}"[ta]`;
  const params = withKeys(new URLSearchParams({
    db: 'pubmed', term, retmode: 'json', retmax: '1000',
    datetype: CONFIG.dateType, reldate: String(CONFIG.windowDays), sort: 'date',
  }));
  const r = await fetchRetry(`${EUTILS}/esearch.fcgi?${params}`);
  const j = await r.json();
  return j?.esearchresult?.idlist || [];
}

async function efetchMedline(pmids) {
  const params = withKeys(new URLSearchParams({
    db: 'pubmed', id: pmids.join(','), rettype: 'medline', retmode: 'text',
  }));
  const r = await fetchRetry(`${EUTILS}/efetch.fcgi?${params}`);
  return await r.text();
}

function parseMedline(text) {
  const records = [];
  for (const block of text.split(/\r?\n\r?\n+/)) {
    if (!block.trim()) continue;
    const fields = {};
    let lastTag = null;
    for (const line of block.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tag = line.slice(0, 4).trim();
      if (tag && line.slice(4, 6) === '- ') {
        lastTag = tag;
        (fields[lastTag] ||= []).push(line.slice(6).trim());
      } else if (lastTag && line.startsWith('      ')) {
        const arr = fields[lastTag];
        arr[arr.length - 1] += ' ' + line.trim();
      }
    }
    records.push(fields);
  }
  return records;
}

function formatAuthors(au = []) {
  if (!au.length) return '';
  const shown = au.slice(0, 6).join(', ');
  return au.length > 6 ? shown + ', et al.' : shown;
}

const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

function resolveDate(f) {
  const dep = f.DEP?.[0];
  if (dep && /^\d{8}$/.test(dep)) return `${dep.slice(0,4)}-${dep.slice(4,6)}-${dep.slice(6,8)}`;
  const dp = f.DP?.[0] || '';
  const m = dp.match(/^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/);
  if (m) {
    const y = m[1];
    const mo = m[2] ? (MONTHS[m[2]] || '01') : '01';
    const d = m[3] ? String(m[3]).padStart(2, '0') : '01';
    return `${y}-${mo}-${d}`;
  }
  return '';
}

function extractDoi(f) {
  for (const v of [...(f.AID || []), ...(f.LID || [])]) {
    const m = v.match(/^(\S+)\s*\[doi\]$/i);
    if (m) return m[1];
  }
  return '';
}

function fallbackStudyType(pts = []) {
  const map = {
    'Randomized Controlled Trial': 'Randomised controlled trial',
    'Meta-Analysis': 'Meta-analysis',
    'Systematic Review': 'Systematic review',
    'Multicenter Study': 'Multicentre study',
    'Comparative Study': 'Comparative study',
    'Observational Study': 'Observational study',
    'Review': 'Review',
  };
  for (const p of pts) if (map[p]) return map[p];
  return '';
}

function toRecord(f, journalDisplay) {
  const pmid = f.PMID?.[0] || '';
  return {
    pmid,
    title: clean(f.TI?.[0] || ''),
    abstract: (f.AB || []).join(' ').replace(/\s+/g, ' ').trim(),
    pts: f.PT || [],
    authors: formatAuthors(f.AU || []),
    date: resolveDate(f),
    journal: journalDisplay,
    url: (() => { const doi = extractDoi(f); return doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`; })(),
  };
}

async function summarise(rec) {
  const system =
    'You summarise an orthopaedic research abstract for a patient-education digest. ' +
    'Reply with ONLY a JSON object and nothing else: no prose, no code fences. ' +
    'Keys: study_type, population, sample_size, outcomes, take_home. Use UK English ' +
    'spelling and NHS-style plain English. Never use em dashes. Each value is a short ' +
    'string; use "" if the abstract does not state it. take_home is one or two sentences ' +
    'on what the study actually found, in plain English a patient could follow. Do not ' +
    'invent numbers or findings that are not in the abstract.';
  const user =
    `Journal: ${rec.journal}\nTitle: ${rec.title}\n` +
    `Publication types: ${rec.pts.join(', ')}\nAbstract: ${rec.abstract}`;
  const body = { model: CONFIG.model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CONFIG.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('Anthropic HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
      const data = await r.json();
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
      return {
        study_type:  clean(parsed.study_type || fallbackStudyType(rec.pts)),
        population:  clean(parsed.population || ''),
        sample_size: clean(parsed.sample_size || ''),
        outcomes:    clean(parsed.outcomes || ''),
        take_home:   clean(parsed.take_home || ''),
      };
    } catch (e) {
      if (attempt === 1) {
        console.warn(`    ! summary failed for PMID ${rec.pmid}: ${e.message}`);
        return { study_type: fallbackStudyType(rec.pts), population: '', sample_size: '', outcomes: '', take_home: '' };
      }
      await sleep(1200);
    }
  }
}

async function collectRecords(journalsWithFilter) {
  const byJournal = [];
  for (const j of journalsWithFilter) {
    const ids = await esearch(j.ta, j.filter);
    console.log(`    ${j.display}: ${ids.length} candidate(s)`);
    if (ids.length) byJournal.push({ j, ids });
    await sleep(CONFIG.ncbiKey ? 120 : 350);
  }
  let records = [];
  for (const { j, ids } of byJournal) {
    for (let k = 0; k < ids.length; k += 200) {
      const text = await efetchMedline(ids.slice(k, k + 200));
      for (const f of parseMedline(text)) {
        const rec = toRecord(f, j.display);
        if (rec.pts.some((p) => SKIP_PUB_TYPES.has(p))) continue;
        if (!rec.abstract || !rec.title) continue;
        records.push(rec);
      }
      await sleep(CONFIG.ncbiKey ? 120 : 350);
    }
  }
  const seen = new Set();
  records = records.filter((r) => (seen.has(r.pmid) ? false : seen.add(r.pmid)));
  records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return records;
}

async function runSubspecialty(sub) {
  console.log(`\n== ${sub.key} ==`);
  const journals = [
    ...sub.specialty.map((j) => ({ ...j, filter: '' })),            // take everything
    ...GENERAL_JOURNALS.map((j) => ({ ...j, filter: sub.filter })), // filtered to the field
  ];
  let records = await collectRecords(journals);
  if (CONFIG.maxArticles > 0 && records.length > CONFIG.maxArticles) records = records.slice(0, CONFIG.maxArticles);
  console.log(`  summarising ${records.length} paper(s)...`);

  const articles = [];
  for (const rec of records) {
    const s = await summarise(rec);
    articles.push({
      id: 'pmid-' + rec.pmid,
      title: rec.title,
      journal: rec.journal,
      authors: clean(rec.authors),
      date: rec.date,
      study_type: s.study_type,
      population: s.population,
      sample_size: s.sample_size,
      outcomes: s.outcomes,
      take_home: s.take_home,
      url: rec.url,
    });
    await sleep(250);
  }

  const monitored = [...sub.specialty.map((j) => j.display), ...GENERAL_JOURNALS.map((j) => j.display)];
  const out = {
    generated_at: new Date().toISOString(),
    is_seed: false,
    subspecialty: sub.key,
    count: articles.length,
    window_days: CONFIG.windowDays,
    journals: monitored,
    articles,
  };
  const json = JSON.stringify(out, null, 2);
  if (json.includes('\u2014')) throw new Error(`Refusing to write ${sub.out}: output contains an em dash.`);
  await mkdir(dirname(sub.out), { recursive: true });
  await writeFile(sub.out, json, 'utf8');
  console.log(`  wrote ${sub.out} with ${articles.length} article(s).`);
}

async function main() {
  if (!CONFIG.anthropicKey) {
    console.error('ANTHROPIC_API_KEY is not set. Add it as a GitHub Actions secret.');
    process.exit(1);
  }
  const subs = CONFIG.only.length
    ? SUBSPECIALTIES.filter((s) => CONFIG.only.includes(s.key))
    : SUBSPECIALTIES;
  console.log(`Window ${CONFIG.windowDays} days (datetype=${CONFIG.dateType}). Running: ${subs.map((s) => s.key).join(', ')}`);
  for (const sub of subs) {
    try {
      await runSubspecialty(sub);
    } catch (e) {
      console.error(`  ${sub.key} failed: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
