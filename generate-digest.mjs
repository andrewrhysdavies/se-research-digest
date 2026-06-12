// generate-digest.mjs
// Weekly shoulder & elbow research digest generator.
// Pure Node.js 20+ (uses the built-in fetch; no external packages to install).
//
// What it does, in order:
//   1. Asks PubMed (free NCBI E-utilities API) for papers added in the last N days
//      from each of the eight monitored journals.
//   2. Pulls each paper's factual record (title, authors, journal, date, DOI, abstract).
//   3. Sends the abstract to the Anthropic API to write the plain-English fields
//      (study type, who was studied, numbers, what was measured, take-home).
//   4. Writes docs/digest.json in exactly the shape the website expects.
//
// Factual fields come from PubMed. Only the summary fields are written by Claude,
// so citations stay accurate and the AI is confined to summarising.
//
// Configuration is via environment variables (all optional except ANTHROPIC_API_KEY):
//   ANTHROPIC_API_KEY  (required)  your Anthropic key, supplied by the workflow secret
//   ANTHROPIC_MODEL    default 'claude-haiku-4-5-20251001' (cheap + fast; see notes)
//   WINDOW_DAYS        default 7   how far back to look
//   PUBMED_DATETYPE    default 'edat' ('edat' = added to PubMed; 'pdat' = publication date)
//   MAX_ARTICLES       default 80  safety cap on a single run
//   OUT_PATH           default 'docs/digest.json'
//   NCBI_API_KEY       optional, raises the PubMed rate limit (free from NCBI)
//   NCBI_EMAIL         optional, polite identifier for NCBI
//
// Model note: model names and pricing change over time. Check the current list and
// prices at https://docs.claude.com before changing ANTHROPIC_MODEL. Haiku is the
// cheapest; set ANTHROPIC_MODEL=claude-sonnet-4-6 for higher-quality summaries.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONFIG = {
  windowDays:   Number(process.env.WINDOW_DAYS || 7),
  dateType:     process.env.PUBMED_DATETYPE || 'edat',
  model:        process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  maxArticles:  Number(process.env.MAX_ARTICLES || 80),
  outPath:      process.env.OUT_PATH || 'docs/digest.json',
  ncbiKey:      process.env.NCBI_API_KEY || '',
  email:        process.env.NCBI_EMAIL || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
};

// The eight monitored journals, with their PubMed title abbreviations.
// takeWhole: true  -> include every recent paper (specialty journals)
// takeWhole: false -> include only shoulder/elbow papers (general journals)
const JOURNALS = [
  { display: 'JSES',              ta: 'J Shoulder Elbow Surg', takeWhole: true  },
  { display: 'Shoulder & Elbow',  ta: 'Shoulder Elbow',        takeWhole: true  },
  { display: 'BJJ',               ta: 'Bone Joint J',          takeWhole: false },
  { display: 'JBJS',              ta: 'J Bone Joint Surg Am',  takeWhole: false },
  { display: 'Bone & Joint Open', ta: 'Bone Jt Open',          takeWhole: false },
  { display: 'Acta Orthopaedica', ta: 'Acta Orthop',           takeWhole: false },
  { display: 'Lancet',            ta: 'Lancet',                takeWhole: false },
  { display: 'BMJ',               ta: 'BMJ',                   takeWhole: false },
];

const SHOULDER_ELBOW_FILTER =
  '(shoulder[tiab] OR "rotator cuff"[tiab] OR glenohumeral[tiab] OR elbow[tiab] OR ' +
  'clavicle[tiab] OR "proximal humerus"[tiab] OR humeral[tiab] OR scapula*[tiab] OR ' +
  'acromioclavicular[tiab] OR "distal biceps"[tiab] OR epicondylitis[tiab])';

// Item types that are not research papers worth summarising.
const SKIP_PUB_TYPES = new Set([
  'Published Erratum', 'Comment', 'Editorial', 'Letter', 'News',
  'Retraction of Publication', 'Retracted Publication', 'Biography', 'Obituary',
]);

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip em dashes (banned across the site) and tidy whitespace.
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

async function esearch(journal) {
  const term = journal.takeWhole
    ? `"${journal.ta}"[ta]`
    : `"${journal.ta}"[ta] AND ${SHOULDER_ELBOW_FILTER}`;
  const params = withKeys(new URLSearchParams({
    db: 'pubmed', term, retmode: 'json', retmax: '120',
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

// Parse MEDLINE text into an array of { TAG: [values] } records.
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
  // Prefer the electronic publication date (DEP, formatted YYYYMMDD).
  const dep = f.DEP?.[0];
  if (dep && /^\d{8}$/.test(dep)) return `${dep.slice(0,4)}-${dep.slice(4,6)}-${dep.slice(6,8)}`;
  // Otherwise parse the publication date string (DP), e.g. "2025 Nov 21" or "2025 Nov".
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
    'You summarise an orthopaedic research abstract for a shoulder and elbow ' +
    'patient-education digest. Reply with ONLY a JSON object and nothing else: no prose, ' +
    'no code fences. Keys: study_type, population, sample_size, outcomes, take_home. ' +
    'Use UK English spelling and NHS-style plain English. Never use em dashes. Each value ' +
    'is a short string; use "" if the abstract does not state it. take_home is one or two ' +
    'sentences on what the study actually found, in plain English a patient could follow. ' +
    'Do not invent numbers or findings that are not in the abstract.';
  const user =
    `Journal: ${rec.journal}\nTitle: ${rec.title}\n` +
    `Publication types: ${rec.pts.join(', ')}\nAbstract: ${rec.abstract}`;

  const body = {
    model: CONFIG.model,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }],
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': CONFIG.anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
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
        console.warn(`  ! summary failed for PMID ${rec.pmid}: ${e.message}`);
        return { study_type: fallbackStudyType(rec.pts), population: '', sample_size: '', outcomes: '', take_home: '' };
      }
      await sleep(1200);
    }
  }
}

async function main() {
  if (!CONFIG.anthropicKey) {
    console.error('ANTHROPIC_API_KEY is not set. Add it as a GitHub Actions secret.');
    process.exit(1);
  }

  console.log(`Looking back ${CONFIG.windowDays} days (datetype=${CONFIG.dateType}).`);

  // 1. Collect PMIDs per journal.
  const collected = [];
  for (const journal of JOURNALS) {
    const ids = await esearch(journal);
    console.log(`  ${journal.display}: ${ids.length} candidate(s)`);
    for (const id of ids) collected.push({ id, journal });
    await sleep(CONFIG.ncbiKey ? 120 : 350); // stay under NCBI rate limits
  }

  if (!collected.length) {
    console.log('No new papers in the window. Writing an empty digest.');
  }

  // 2. Fetch records per journal (batch efetch), parse, filter.
  const byJournal = new Map();
  for (const { id, journal } of collected) {
    if (!byJournal.has(journal.display)) byJournal.set(journal.display, { journal, ids: [] });
    byJournal.get(journal.display).ids.push(id);
  }

  let records = [];
  for (const { journal, ids } of byJournal.values()) {
    const text = await efetchMedline(ids);
    for (const f of parseMedline(text)) {
      const rec = toRecord(f, journal.display);
      const isSkippable = rec.pts.some((p) => SKIP_PUB_TYPES.has(p));
      if (isSkippable) continue;
      if (!rec.abstract) continue;       // need an abstract to summarise accurately
      if (!rec.title) continue;
      records.push(rec);
    }
    await sleep(CONFIG.ncbiKey ? 120 : 350);
  }

  // De-duplicate by PMID and cap.
  const seen = new Set();
  records = records.filter((r) => (seen.has(r.pmid) ? false : seen.add(r.pmid)));
  records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (records.length > CONFIG.maxArticles) records = records.slice(0, CONFIG.maxArticles);
  console.log(`Summarising ${records.length} paper(s)...`);

  // 3. Summarise each (sequential, gentle on the API).
  const articles = [];
  for (const rec of records) {
    const summary = await summarise(rec);
    articles.push({
      id: 'pmid-' + rec.pmid,
      title: rec.title,
      journal: rec.journal,
      authors: clean(rec.authors),
      date: rec.date,
      study_type: summary.study_type,
      population: summary.population,
      sample_size: summary.sample_size,
      outcomes: summary.outcomes,
      take_home: summary.take_home,
      url: rec.url,
    });
    await sleep(250);
  }

  // 4. Write the file in the exact shape the page reads.
  const out = {
    generated_at: new Date().toISOString(),
    is_seed: false,
    count: articles.length,
    window_days: CONFIG.windowDays,
    journals: JOURNALS.map((j) => j.display),
    articles,
  };

  const json = JSON.stringify(out, null, 2);
  if (json.includes('\u2014')) throw new Error('Refusing to write: output contains an em dash.');
  await mkdir(dirname(CONFIG.outPath), { recursive: true });
  await writeFile(CONFIG.outPath, json, 'utf8');
  console.log(`Wrote ${CONFIG.outPath} with ${articles.length} article(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
