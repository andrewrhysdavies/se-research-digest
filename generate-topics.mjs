// generate-topics.mjs
// MONTHLY topic digest generator for the Orthopaedic Club.
// Pure Node.js 20+ (built-in fetch; no packages to install).
//
// Unlike the weekly digest (what is new), a topic digest is a curated standing
// list: the strongest evidence on one topic from the last N years, in the noted
// journals, capped to a readable number and ordered by evidence quality.
//
// For each topic it:
//   1. Asks PubMed for papers on the topic in the listed journals, restricted to
//      higher-evidence publication types (RCTs, systematic reviews, meta-analyses,
//      guidelines, multicentre and observational/cohort studies), in the last N years.
//   2. Ranks them by evidence tier first, then recency, and keeps the top N.
//   3. Summarises each abstract via Claude (plain English), REUSING any summary it
//      already wrote in a previous run so monthly runs are cheap and stable.
//   4. Writes docs/topic-<key>.json in the shape the topic page reads.
//
// Study type is taken from PubMed publication tags, never invented. The AI only
// writes population / sample_size / outcomes / take_home. Final curation and any
// quality appraisal ("large", "well designed") stays with the clinician.
//
// Env (only ANTHROPIC_API_KEY required): ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
// TOPIC_YEARS (default 10), TOP_N (default 25), ONLY (comma-separated topic keys),
// NCBI_API_KEY, NCBI_EMAIL.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONFIG = {
  years:        Number(process.env.TOPIC_YEARS || 10),
  topN:         Number(process.env.TOP_N || 25),
  model:        process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  only:         (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean),
  ncbiKey:      process.env.NCBI_API_KEY || '',
  email:        process.env.NCBI_EMAIL || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
};

// The noted shoulder/elbow journal set (specialty + general). A topic only includes
// these journals; the topic filter + evidence filter keep results relevant.
const JOURNALS = [
  { display: 'JSES',             ta: 'J Shoulder Elbow Surg' },
  { display: 'Shoulder & Elbow', ta: 'Shoulder Elbow' },
  { display: 'BJJ',              ta: 'Bone Joint J' },
  { display: 'JBJS',             ta: 'J Bone Joint Surg Am' },
  { display: 'Bone & Joint Open',ta: 'Bone Jt Open' },
  { display: 'Acta Orthopaedica',ta: 'Acta Orthop' },
  { display: 'Lancet',           ta: 'Lancet' },
  { display: 'BMJ',              ta: 'BMJ' },
  { display: 'NEJM',             ta: 'N Engl J Med' },
];

// Higher-evidence publication types to include.
const EVIDENCE_PT = [
  'Randomized Controlled Trial', 'Meta-Analysis', 'Systematic Review',
  'Practice Guideline', 'Guideline', 'Multicenter Study', 'Observational Study',
];

const TOPICS = [
  {
    key: 'rotator-cuff',
    name: 'Rotator cuff',
    out: 'docs/topic-rotator-cuff.json',
    // Topic filter (title/abstract + MeSH). Edit freely to widen or narrow.
    filter: '("rotator cuff"[tiab] OR "Rotator Cuff"[Mesh] OR "Rotator Cuff Injuries"[Mesh] OR ' +
            'supraspinatus[tiab] OR infraspinatus[tiab] OR subscapularis[tiab] OR ' +
            '"cuff repair"[tiab] OR "cuff tear"[tiab] OR "cuff tendinopathy"[tiab])',
  },
];

// Evidence tier: lower number = stronger / shown higher up.
function tierOf(studyType) {
  const order = ['Clinical guideline', 'Meta-analysis', 'Systematic review',
                 'Randomised controlled trial', 'Multicentre cohort',
                 'Cohort or observational study', 'Study'];
  const i = order.indexOf(studyType);
  return i === -1 ? order.length : i;
}
// Map PubMed publication tags to a single study-type label (factual, not AI).
function studyTypeFromPT(pts = []) {
  if (pts.includes('Practice Guideline') || pts.includes('Guideline')) return 'Clinical guideline';
  if (pts.includes('Meta-Analysis')) return 'Meta-analysis';
  if (pts.includes('Systematic Review')) return 'Systematic review';
  if (pts.includes('Randomized Controlled Trial')) return 'Randomised controlled trial';
  if (pts.includes('Multicenter Study')) return 'Multicentre cohort';
  if (pts.includes('Observational Study')) return 'Cohort or observational study';
  return 'Study';
}

const SKIP_PUB_TYPES = new Set([
  'Published Erratum', 'Comment', 'Editorial', 'Letter', 'News',
  'Retraction of Publication', 'Retracted Publication', 'Biography', 'Obituary',
]);

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/\s*\u2014\s*/g, ', ').replace(/\u2014/g, '-')
    .replace(/\s+/g, ' ').trim();
}
async function fetchRetry(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { if (i === tries - 1) throw e; await sleep(800 * (i + 1)); }
  }
}
function withKeys(params) {
  if (CONFIG.ncbiKey) params.set('api_key', CONFIG.ncbiKey);
  if (CONFIG.email) params.set('email', CONFIG.email);
  return params;
}
async function esearchTopic(topic) {
  const journalsOr = '(' + JOURNALS.map((j) => `"${j.ta}"[ta]`).join(' OR ') + ')';
  const evidenceOr = '(' + EVIDENCE_PT.map((p) => `"${p}"[pt]`).join(' OR ') + ')';
  const term = `${journalsOr} AND ${topic.filter} AND ${evidenceOr}`;
  const params = withKeys(new URLSearchParams({
    db: 'pubmed', term, retmode: 'json', retmax: '300',
    datetype: 'pdat', reldate: String(CONFIG.years * 365), sort: 'date',
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
    const fields = {}; let lastTag = null;
    for (const line of block.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tag = line.slice(0, 4).trim();
      if (tag && line.slice(4, 6) === '- ') { lastTag = tag; (fields[lastTag] ||= []).push(line.slice(6).trim()); }
      else if (lastTag && line.startsWith('      ')) { const a = fields[lastTag]; a[a.length - 1] += ' ' + line.trim(); }
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
  const dp = f.DP?.[0] || ''; const m = dp.match(/^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/);
  if (m) return `${m[1]}-${m[2] ? (MONTHS[m[2]] || '01') : '01'}-${m[3] ? String(m[3]).padStart(2,'0') : '01'}`;
  return '';
}
function extractDoi(f) {
  for (const v of [...(f.AID || []), ...(f.LID || [])]) { const m = v.match(/^(\S+)\s*\[doi\]$/i); if (m) return m[1]; }
  return '';
}
function journalDisplay(f) {
  const ta = (f.TA?.[0] || '').trim();
  const hit = JOURNALS.find((j) => j.ta.toLowerCase() === ta.toLowerCase());
  return hit ? hit.display : (ta || 'Journal');
}

async function summarise(rec) {
  const system =
    'You summarise an orthopaedic research abstract for a patient-education topic page. ' +
    'Reply with ONLY a JSON object: keys population, sample_size, outcomes, take_home. ' +
    'UK English, NHS-style plain English, no em dashes. Each value a short string; use "" ' +
    'if the abstract does not state it. take_home is one or two sentences on what this study ' +
    'actually found, in plain English. Do not invent numbers or findings not in the abstract.';
  const user = `Title: ${rec.title}\nStudy type: ${rec.study_type}\nAbstract: ${rec.abstract}`;
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
        population:  clean(parsed.population || ''),
        sample_size: clean(parsed.sample_size || ''),
        outcomes:    clean(parsed.outcomes || ''),
        take_home:   clean(parsed.take_home || ''),
      };
    } catch (e) {
      if (attempt === 1) { console.warn(`    ! summary failed for PMID ${rec.pmid}: ${e.message}`); return { population:'', sample_size:'', outcomes:'', take_home:'' }; }
      await sleep(1200);
    }
  }
}

async function loadExisting(outPath) {
  try {
    const prev = JSON.parse(await readFile(outPath, 'utf8'));
    const map = new Map();
    (prev.articles || []).forEach((a) => map.set(a.id, a));
    return map;
  } catch { return new Map(); }
}

async function runTopic(topic) {
  console.log(`\n== topic: ${topic.key} ==`);
  const ids = await esearchTopic(topic);
  console.log(`  ${ids.length} candidate(s) from PubMed`);
  if (!ids.length) { await writeTopic(topic, []); return; }

  // Fetch + parse + keep those with abstracts and a real evidence type.
  let records = [];
  for (let k = 0; k < ids.length; k += 200) {
    const text = await efetchMedline(ids.slice(k, k + 200));
    for (const f of parseMedline(text)) {
      const pts = f.PT || [];
      if (pts.some((p) => SKIP_PUB_TYPES.has(p))) continue;
      const abstract = (f.AB || []).join(' ').replace(/\s+/g, ' ').trim();
      const title = clean(f.TI?.[0] || '');
      if (!abstract || !title) continue;
      const study_type = studyTypeFromPT(pts);
      const pmid = f.PMID?.[0] || '';
      const doi = extractDoi(f);
      records.push({
        pmid, title, abstract, study_type,
        authors: formatAuthors(f.AU || []), date: resolveDate(f), journal: journalDisplay(f),
        url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    }
    await sleep(CONFIG.ncbiKey ? 120 : 350);
  }
  // Dedupe, rank by evidence tier then recency, keep top N.
  const seen = new Set();
  records = records.filter((r) => (seen.has(r.pmid) ? false : seen.add(r.pmid)));
  records.sort((a, b) => (tierOf(a.study_type) - tierOf(b.study_type)) || (b.date || '').localeCompare(a.date || ''));
  records = records.slice(0, CONFIG.topN);
  console.log(`  keeping top ${records.length} by evidence tier then date`);

  // Reuse existing summaries; only summarise genuinely new entries.
  const existing = await loadExisting(topic.out);
  let reused = 0, fresh = 0;
  const articles = [];
  for (const rec of records) {
    const id = 'pmid-' + rec.pmid;
    const prev = existing.get(id);
    let s;
    if (prev && (prev.take_home || prev.outcomes)) { s = prev; reused++; }
    else { const out = await summarise(rec); fresh++; await sleep(250);
           s = { population: out.population, sample_size: out.sample_size, outcomes: out.outcomes, take_home: out.take_home }; }
    articles.push({
      id, title: rec.title, journal: rec.journal, authors: clean(rec.authors), date: rec.date,
      study_type: rec.study_type, population: s.population || '', sample_size: s.sample_size || '',
      outcomes: s.outcomes || '', take_home: s.take_home || '', url: rec.url,
    });
  }
  console.log(`  summaries: ${reused} reused, ${fresh} newly written`);
  await writeTopic(topic, articles);
}

async function writeTopic(topic, articles) {
  const out = {
    generated_at: new Date().toISOString(), is_seed: false,
    topic_key: topic.key, topic_name: topic.name,
    count: articles.length, years: CONFIG.years, top_n: CONFIG.topN,
    journals: JOURNALS.map((j) => j.display), articles,
  };
  const json = JSON.stringify(out, null, 2);
  if (json.includes('\u2014')) throw new Error(`Refusing to write ${topic.out}: contains an em dash.`);
  await mkdir(dirname(topic.out), { recursive: true });
  await writeFile(topic.out, json, 'utf8');
  console.log(`  wrote ${topic.out} with ${articles.length} article(s).`);
}

async function main() {
  if (!CONFIG.anthropicKey) { console.error('ANTHROPIC_API_KEY is not set.'); process.exit(1); }
  const topics = CONFIG.only.length ? TOPICS.filter((t) => CONFIG.only.includes(t.key)) : TOPICS;
  console.log(`Topic digest: last ${CONFIG.years} years, top ${CONFIG.topN}. Running: ${topics.map((t) => t.key).join(', ')}`);
  for (const t of topics) { try { await runTopic(t); } catch (e) { console.error(`  ${t.key} failed: ${e.message}`); } }
}
main().catch((e) => { console.error(e); process.exit(1); });
