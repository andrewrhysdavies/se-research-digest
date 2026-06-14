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

// Relevance screen applied to EVERY topic: drop non-clinical work (cadaveric,
// biomechanical, in-vitro), study protocols (no results yet) and retracted papers.
const GLOBAL_EXCLUDE =
  'cadaver*[tiab] OR biomechanic*[tiab] OR "in vitro"[tiab] OR ' +
  '"study protocol"[ti] OR "rationale and design"[ti] OR "Clinical Trial Protocol"[pt] OR ' +
  '"Retracted Publication"[pt] OR "Expression of Concern"[pt]';

const TOPICS = [
  {
    key: 'rotator-cuff',
    name: 'Rotator cuff',
    out: 'docs/topic-rotator-cuff.json',
    // Recall filter: cuff as a MeSH term/major topic OR anywhere in title/abstract, so
    // relevant papers that frame the topic differently (e.g. "subacromial pain") are still
    // found. Precision is handled afterwards by the AI relevance gate, not by this filter.
    filter: '("Rotator Cuff"[Majr] OR "Rotator Cuff"[Mesh] OR "Rotator Cuff Injuries"[Mesh] OR ' +
            '"rotator cuff"[tiab] OR supraspinatus[tiab] OR infraspinatus[tiab] OR subscapularis[tiab] OR ' +
            '"cuff repair"[tiab] OR "cuff tear"[tiab] OR "cuff tendinopathy"[tiab])',
    // Keep this to native-shoulder cuff disease: exclude papers focused on shoulder
    // replacement / arthroplasty and on cuff tear arthropathy (the end-stage arthritic
    // shoulder treated with reverse replacement). Arthroplasty terms are matched in the
    // title only, so a native-shoulder paper that merely mentions replacement as a
    // salvage option in its abstract is still kept.
    exclude: 'arthroplasty[ti] OR "shoulder replacement"[ti] OR "reverse shoulder"[ti] OR ' +
             '"reverse total shoulder"[ti] OR hemiarthroplasty[ti] OR ' +
             '"cuff tear arthropathy"[tiab] OR "rotator cuff arthropathy"[tiab] OR ' +
             '"cuff arthropathy"[tiab] OR "Arthroplasty, Replacement, Shoulder"[Mesh]',
    // Plain-English relevance scope, applied per paper by the AI relevance gate. Edit freely.
    scope: 'Clinical research on the assessment, non-operative treatment, surgical repair or outcomes ' +
           'of rotator cuff tears, cuff tendinopathy or related cuff disease in the native (non-replaced) ' +
           'shoulder. Out of scope: studies primarily about shoulder replacement or cuff tear arthropathy; ' +
           'pure imaging or diagnostic-test development without clinical management or outcomes; basic ' +
           'science, anatomy or biomechanics; and studies where the rotator cuff is only incidental.',
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

// NIH iCite citation metrics by PMID. Free, no key, up to 1000 ids per call.
// Returns Map(pmid -> {rcr, citations, nih_percentile}). Failures degrade to empty.
async function fetchICite(pmids) {
  const out = new Map();
  for (let k = 0; k < pmids.length; k += 600) {
    const chunk = pmids.slice(k, k + 600);
    try {
      const r = await fetchRetry('https://icite.od.nih.gov/api/pubs?pmids=' + chunk.join(','));
      const j = await r.json();
      (j.data || []).forEach((d) => out.set(String(d.pmid), {
        rcr: (d.relative_citation_ratio == null ? null : Number(d.relative_citation_ratio)),
        citations: (d.citation_count == null ? null : Number(d.citation_count)),
        nih_percentile: (d.nih_percentile == null ? null : Number(d.nih_percentile)),
      }));
    } catch (e) {
      console.warn(`    ! iCite fetch failed for a chunk: ${e.message}`);
    }
    await sleep(150);
  }
  return out;
}
async function esearchTopic(topic) {
  const journalsOr = '(' + JOURNALS.map((j) => `"${j.ta}"[ta]`).join(' OR ') + ')';
  const evidenceOr = '(' + EVIDENCE_PT.map((p) => `"${p}"[pt]`).join(' OR ') + ')';
  const term = `${journalsOr} AND ${topic.filter} AND ${evidenceOr}` +
               ` NOT (${[GLOBAL_EXCLUDE, topic.exclude].filter(Boolean).join(' OR ')})`;
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

// Trial / review registration, read from the MEDLINE SI field (verified metadata).
function parseRegistration(f) {
  for (const v of (f.SI || [])) {
    const m = v.match(/^\s*([^/]+)\/(\S+)/);
    if (!m) continue;
    const registry = m[1].trim();
    const id = m[2].trim();
    const rl = registry.toLowerCase();
    let url = '';
    if (rl.includes('clinicaltrials')) url = 'https://clinicaltrials.gov/study/' + id;
    else if (rl.includes('isrctn')) url = 'https://www.isrctn.com/' + id;
    else if (rl.includes('prospero')) url = 'https://www.crd.york.ac.uk/prospero/display_record.php?RecordID=' + id.replace(/\D/g, '');
    return { registry, id, url };
  }
  return null;
}

// AI relevance gate. Classifies each candidate against the topic's editable scope as
// core / related / off, judging only from title + abstract. This is a comprehension
// task (not a quality judgement); on any error it defaults to "related" so nothing
// on-topic is silently dropped. Off-topic papers are removed before ranking.
async function classifyRelevance(topic, batch) {
  const system =
    'You decide whether each study fits a clinical evidence digest topic. Reply with ONLY a JSON ' +
    'array, one object per study in the same order, each with keys i (the bracketed index), ' +
    'relevance and reason. relevance is "core" (the study is primarily about the topic as defined), ' +
    '"related" (it touches the topic but that is not its main focus), or "off" (not about the topic). ' +
    'Judge only from the title and abstract. If unsure, use "related", never "off". reason is a short ' +
    'phrase. No em dashes.';
  const items = batch.map((r, i) => `[${i}] Title: ${r.title}\nAbstract: ${(r.abstract || '').slice(0, 700)}`).join('\n\n');
  const user = `Topic scope:\n${topic.scope}\n\nClassify each study below.\n\n${items}`;
  const body = { model: CONFIG.model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CONFIG.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const arr = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
    const out = {};
    (Array.isArray(arr) ? arr : []).forEach((o, idx) => {
      const i = Number.isInteger(o.i) ? o.i : idx;
      out[i] = { relevance: o.relevance, reason: o.reason };
    });
    return out;
  } catch (e) {
    console.warn(`    ! relevance batch failed (kept as related): ${e.message}`);
    return {};
  }
}

async function relevanceGate(topic, pool, existing) {
  if (!topic.scope) { pool.forEach((r) => { r.relevance = 'core'; r.relevance_reason = ''; }); return; }
  const todo = [];
  for (const r of pool) {
    const prev = existing.get('pmid-' + r.pmid);
    if (prev && prev.relevance) { r.relevance = prev.relevance; r.relevance_reason = prev.relevance_reason || ''; }
    else todo.push(r);
  }
  let gated = 0;
  for (let k = 0; k < todo.length; k += 8) {
    const batch = todo.slice(k, k + 8);
    const res = await classifyRelevance(topic, batch);
    batch.forEach((r, i) => {
      const c = res[i] || {};
      r.relevance = (c.relevance === 'core' || c.relevance === 'off') ? c.relevance : 'related';
      r.relevance_reason = clean(c.reason || '');
      gated++;
    });
    await sleep(250);
  }
  console.log(`  relevance: ${pool.length - todo.length} reused, ${gated} newly classified`);
}

async function summarise(rec) {
  const system =
    'You read an orthopaedic research abstract for a clinical evidence digest. Reply with ONLY a JSON ' +
    'object with keys: population, sample_size, outcomes, take_home, appraisal. population, sample_size ' +
    'and outcomes are short strings; take_home is one or two plain-English sentences on what the study ' +
    'found. appraisal is an object with keys n, followup, included_studies, participants, i2. Fill an ' +
    'appraisal field ONLY if the abstract explicitly states it, otherwise use null; never infer, ' +
    'estimate or calculate. n = total patients enrolled (integer). followup = the longest follow-up ' +
    'stated (short string e.g. "2 years"). For systematic reviews and meta-analyses only: ' +
    'included_studies = number of studies included (integer), participants = total participants pooled ' +
    '(integer), i2 = the I-squared heterogeneity percentage (number 0 to 100). UK English, no em dashes. ' +
    'Use "" for empty strings and null for empty appraisal fields.';
  const user = `Title: ${rec.title}\nStudy type: ${rec.study_type}\nAbstract: ${rec.abstract}`;
  const body = { model: CONFIG.model, max_tokens: 800, system, messages: [{ role: 'user', content: user }] };
  const intOrNull = (v, max) => { const n = Number(v); return (Number.isInteger(n) && n > 0 && n <= max) ? n : null; };
  const numRange = (v, lo, hi) => { const n = Number(v); return (Number.isFinite(n) && n >= lo && n <= hi) ? n : null; };
  const emptyAppraisal = { n: null, followup: null, included_studies: null, participants: null, i2: null };
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
      const ap = parsed.appraisal || {};
      const fu = ap.followup;
      return {
        population:  clean(parsed.population || ''),
        sample_size: clean(parsed.sample_size || ''),
        outcomes:    clean(parsed.outcomes || ''),
        take_home:   clean(parsed.take_home || ''),
        appraisal: {
          n: intOrNull(ap.n, 1000000),
          followup: (typeof fu === 'string' && fu.trim() && fu.length <= 40) ? clean(fu) : null,
          included_studies: intOrNull(ap.included_studies, 10000),
          participants: intOrNull(ap.participants, 10000000),
          i2: numRange(ap.i2, 0, 100),
        },
      };
    } catch (e) {
      if (attempt === 1) { console.warn(`    ! summary failed for PMID ${rec.pmid}: ${e.message}`); return { population:'', sample_size:'', outcomes:'', take_home:'', appraisal: emptyAppraisal }; }
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
        registration: parseRegistration(f),
        multicentre: pts.includes('Multicenter Study'),
      });
    }
    await sleep(CONFIG.ncbiKey ? 120 : 350);
  }
  // Dedupe.
  const seen = new Set();
  records = records.filter((r) => (seen.has(r.pmid) ? false : seen.add(r.pmid)));

  // Visibility: how many candidates each configured journal returned (before ranking).
  const candByJournal = {};
  records.forEach((r) => { candByJournal[r.journal] = (candByJournal[r.journal] || 0) + 1; });
  JOURNALS.forEach((j) => { if (!(j.display in candByJournal)) candByJournal[j.display] = 0; });
  console.log('  candidates by journal: ' +
    Object.entries(candByJournal).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));

  // Citation impact (NIH iCite): factual, field- and time-normalised. Attach RCR,
  // citation count and NIH percentile to each candidate.
  const icite = await fetchICite(records.map((r) => r.pmid));
  records.forEach((r) => {
    const m = icite.get(String(r.pmid)) || {};
    r.rcr = (m.rcr == null ? null : m.rcr);
    r.citations = (m.citations == null ? null : m.citations);
    r.nih_percentile = (m.nih_percentile == null ? null : m.nih_percentile);
  });

  // Rank: evidence tier first (hierarchy), then citation impact within tier, then recency.
  // RCR needs roughly two years of citations to stabilise, so very recent papers (or any
  // with no RCR yet) are scored at the field median (1.0) rather than penalised, then
  // ordered by date so genuinely new work is not buried.
  const now = Date.now();
  const ageMonths = (d) => (!d ? 999 : (now - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.4));
  const effRcr = (r) => (r.rcr != null && ageMonths(r.date) >= 24) ? r.rcr : 1.0;
  records.sort((a, b) =>
    (tierOf(a.study_type) - tierOf(b.study_type)) ||
    (effRcr(b) - effRcr(a)) ||
    (b.date || '').localeCompare(a.date || ''));

  // Load any previous run (reused summaries + relevance classifications).
  const existing = await loadExisting(topic.out);

  // Relevance gate on a generous pre-ranked pool: classify against the topic scope,
  // drop off-topic, then re-rank preferring on-topic ("core") studies within each tier.
  const POOL = Math.max(CONFIG.topN * 2, 40);
  let pool = records.slice(0, POOL);
  await relevanceGate(topic, pool, existing);
  const before = pool.length;
  pool = pool.filter((r) => r.relevance !== 'off');
  console.log(`  dropped ${before - pool.length} off-topic; ${pool.length} remain`);
  const relRank = (r) => (r.relevance === 'core' ? 0 : 1);
  pool.sort((a, b) =>
    (tierOf(a.study_type) - tierOf(b.study_type)) ||
    (relRank(a) - relRank(b)) ||
    (effRcr(b) - effRcr(a)) ||
    (b.date || '').localeCompare(a.date || ''));
  records = pool.slice(0, CONFIG.topN);
  console.log(`  keeping top ${records.length} by tier, relevance, citation impact, then date`);

  // Reuse existing summaries; re-summarise if missing or lacking the appraisal block.
  let reused = 0, fresh = 0;
  const articles = [];
  for (const rec of records) {
    const id = 'pmid-' + rec.pmid;
    const prev = existing.get(id);
    let s;
    if (prev && prev.take_home && prev.appraisal) { s = prev; reused++; }
    else {
      const out = await summarise(rec); fresh++; await sleep(250);
      s = { population: out.population, sample_size: out.sample_size, outcomes: out.outcomes, take_home: out.take_home, appraisal: out.appraisal };
    }
    articles.push({
      id, title: rec.title, journal: rec.journal, authors: clean(rec.authors), date: rec.date,
      study_type: rec.study_type, population: s.population || '', sample_size: s.sample_size || '',
      outcomes: s.outcomes || '', take_home: s.take_home || '', url: rec.url,
      rcr: (rec.rcr == null ? null : rec.rcr),
      citations: (rec.citations == null ? null : rec.citations),
      nih_percentile: (rec.nih_percentile == null ? null : rec.nih_percentile),
      registration: rec.registration || null,
      multicentre: !!rec.multicentre,
      appraisal: s.appraisal || null,
      relevance: rec.relevance || null,
      relevance_reason: rec.relevance_reason || '',
    });
  }
  console.log(`  summaries: ${reused} reused, ${fresh} newly written`);
  const finalByJournal = {};
  articles.forEach((a) => { finalByJournal[a.journal] = (finalByJournal[a.journal] || 0) + 1; });
  console.log('  final selection by journal: ' +
    Object.entries(finalByJournal).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
  await writeTopic(topic, articles, finalByJournal);
}

async function writeTopic(topic, articles, journalBreakdown) {
  const out = {
    generated_at: new Date().toISOString(), is_seed: false,
    topic_key: topic.key, topic_name: topic.name,
    count: articles.length, years: CONFIG.years, top_n: CONFIG.topN,
    journals: JOURNALS.map((j) => j.display),
    journal_breakdown: journalBreakdown || {},
    articles,
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
