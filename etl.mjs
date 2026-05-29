#!/usr/bin/env node
/* =====================================================================
   etl.mjs — SDMX ETL for the State Statistics Service of Ukraine
   Pulls official data from stat.gov.ua and writes a compact `model.json`
   that the React app consumes.

   SETUP
     npm install fast-xml-parser
     (Node 18+ required — uses the global fetch())

   COMMANDS
     node etl.mjs list                 list every dataflow (find IDs here)
     node etl.mjs search <word>        filter the dataflow list
     node etl.mjs inspect <DF_ID>      show a dataflow's dimensions + codes
     node etl.mjs build                pull configured data -> model.json

   WORKFLOW
     1. `list` / `search wage` etc. to find the dataflow IDs you need.
     2. `inspect <ID>` to see its dimensions and codelist codes.
     3. `build`. Any dataflow that fails falls back to PLACEHOLDER values.

   NOTE: The data endpoint requires Accept: application/json (not SDMX-JSON).
   Tested against Derzhstat API v2.1 — last verified 2026-05.
   ===================================================================== */

import { writeFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { cacheRead as _cacheRead, cacheWrite as _cacheWrite, decodeSdmxJson } from "./src/etl-core.js";

const CACHE_DIR = ".etl-cache";
const cacheRead  = (id)       => _cacheRead(CACHE_DIR, id);
const cacheWrite = (id, data) => _cacheWrite(CACHE_DIR, id, data);

/* ----------------------------- CONFIG ----------------------------- */

const API = "https://stat.gov.ua/sdmx/workspaces/default:integration/registry/sdmx/2.1";
const AGENCY = "SSSU";
const OUT = "public/model.json";
const LANG = "en";

// Real Derzhstat dataflow IDs discovered via `list` / `inspect`.
const DATAFLOWS = {
  population: {
    id: "DF_POPULATION_STRUCTURE",
    version: "latest",
    key: "all",
    // Dimensions (in order): INDICATOR, REGION, AGE, GENDER, TERRAIN_TYPE, FREQ
    // Age-specific data only exists under INDICATOR=PNMI_02 (constant population).
    // PNMI_01 (resident pop) exists only for age=_T totals — used below for population totals.
  },
  wages: {
    id: "DF_SALARY_LEVEL_OF_EMPLOYEES",
    version: "latest",
    key: "all",
    // Dimensions: INDICATOR, PERIOD_OF_TIME, SEX, REGION, BREAKDOWN_CATEGORY, BREAKDOWN, FREQ
  },
  labourForce: {
    id: "DF_LABOR_FORCE_A",
    version: "latest",
    key: "all",
    // Dimensions: INDICATOR, REGION, BREAKDOWN_CATEGORY, BREAKDOWN, AGE_GROUP, GENDER,
    //             TERRAIN_TYPE, UNITS_OF_MEASURE, FREQ
    // Used for both education rates and employment rates.
  },
};

/* ---- Values NOT available from Derzhstat SDMX — entered by hand. ----
   Sources: WHO STEPS survey (Ukraine, 2019); household surveys.
   Update these from the cited reports; the ETL just copies them through. */
const MANUAL = {
  height: {
    man: { mean: 176.0, sd: 7.0 },
    woman: { mean: 165.5, sd: 6.2 },
  },
  smoking: {
    man: 0.503,
    woman: 0.167,
    higherEdMultiplier: 0.72,
  },
  teetotal: {
    man: 0.22,
    woman: 0.42,
  },
  kids: { midAge: 30, steepness: 0.28, manFactor: 0.92, womanFactor: 0.97 },
  ownsHome: { base: 0.18, ageSlope: 0.011, incomeBonus: 0.08 },
  hasCar: { incomeMid: 25000, incomeScale: 22000, manFactor: 1.05, womanFactor: 0.9 },
  serving: { manPeakAge: 37, manPeakProb: 0.14, manSpread: 420, womanProb: 0.02 },
};

/* ---- Fallback values used when a dataflow fetch fails. ---- */
const PLACEHOLDER = {
  population: { man: 11_500_000, woman: 14_800_000 },
  ageBands: [
    { from: 18, to: 24, man: 0.085, woman: 0.078 },
    { from: 25, to: 29, man: 0.092, woman: 0.088 },
    { from: 30, to: 34, man: 0.115, woman: 0.110 },
    { from: 35, to: 39, man: 0.122, woman: 0.118 },
    { from: 40, to: 44, man: 0.112, woman: 0.110 },
    { from: 45, to: 49, man: 0.096, woman: 0.097 },
    { from: 50, to: 54, man: 0.092, woman: 0.095 },
    { from: 55, to: 59, man: 0.090, woman: 0.097 },
    { from: 60, to: 64, man: 0.084, woman: 0.099 },
    { from: 65, to: 69, man: 0.068, woman: 0.061 },
    { from: 70, to: 78, man: 0.044, woman: 0.047 },
  ],
  education: {
    man:   [{ from: 18, to: 29, p: 0.46 }, { from: 30, to: 44, p: 0.42 }, { from: 45, to: 78, p: 0.34 }],
    woman: [{ from: 18, to: 29, p: 0.55 }, { from: 30, to: 44, p: 0.50 }, { from: 45, to: 78, p: 0.40 }],
  },
  income: {
    man:   { logMean: 9.95, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
    woman: { logMean: 9.77, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
  },
  employment: {
    man:   { base: 0.66, youngPenalty: 0.04, oldPenalty: 0.045 },
    woman: { base: 0.58, youngPenalty: 0.04, oldPenalty: 0.045 },
  },
};

/* --------------------------- SDMX helpers -------------------------- */

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function nameOf(node, lang = LANG) {
  const names = arr(node?.Name);
  const hit = names.find((n) => n["@lang"] === lang || n["@xml:lang"] === lang) || names[0];
  return (hit && (hit["#text"] ?? hit)) || "";
}

async function getXml(url, accept = "application/vnd.sdmx.structure+xml;version=2.1") {
  const res = await fetch(url, { headers: { Accept: accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n  ${url}`);
  return xml.parse(await res.text());
}

// Fetch a dataflow as SDMX-JSON (application/json — the only format Derzhstat serves).
// Returns the raw parsed JSON; call decodeSdmxJson() to get flat observation objects,
// or use extractXxx() functions below for large dataflows.
async function fetchDataJson(dfId, retries = 3) {
  const url = `${API}/data/${dfId}/all/${AGENCY}`;
  let data = null;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 4000 * attempt));
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(60000),
    }).catch((e) => { lastErr = e; return null; });
    if (!res?.ok) { lastErr = lastErr ?? new Error(`HTTP ${res?.status} (attempt ${attempt})`); continue; }
    const parsed = JSON.parse(await res.text());
    if (!parsed.dataSets) { lastErr = new Error("No dataSets in response"); continue; }
    data = parsed;
    cacheWrite(dfId, data);
    break;
  }

  if (!data) {
    const cached = cacheRead(dfId);
    if (cached) {
      console.warn(`  API unavailable (${lastErr?.message}) — using cached response for ${dfId}`);
      data = cached;
    } else {
      throw lastErr ?? new Error(`fetchDataJson failed for ${dfId}`);
    }
  }

  return data;
}

/* --------------------- Population extraction ---------------------- */
// DF_POPULATION_STRUCTURE is ~36 MB. Instead of decoding all observations
// we directly index into the series object using known dimension indices.

function extractPopulation(raw) {
  const dims = raw.structure.dimensions.series;
  const timeDims = raw.structure.dimensions.observation;
  const times = (timeDims[0]?.values ?? []).map((v) => v.id ?? String(v));

  const annualIdxs = times
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => /^\d{4}$/.test(t));
  if (!annualIdxs.length) throw new Error("No annual time periods found in DF_POPULATION_STRUCTURE");

  const dimPos = Object.fromEntries(dims.map((d, i) => [d.id, i]));
  const valIdx = (dimId, code) =>
    dims[dimPos[dimId]]?.values.findIndex((v) => (v.id ?? v) === code) ?? -1;

  const V = {
    PNMI_02:  valIdx("INDICATOR",    "PNMI_02"),
    PNMI_01:  valIdx("INDICATOR",    "PNMI_01"),
    Ukraine:  valIdx("REGION",       "UA00000000000000000"),
    MALE:     valIdx("GENDER",       "MALE"),
    FEMALE:   valIdx("GENDER",       "FEMALE"),
    terrainT: valIdx("TERRAIN_TYPE", "_T"),
    ageT:     valIdx("AGE",          "_T"),
    A:        valIdx("FREQ",         "A"),
  };

  const series = raw.dataSets[0].series;
  const ndims = dims.length;

  const getLatestAnnual = (s) => {
    if (!s?.observations) return null;
    for (let i = annualIdxs.length - 1; i >= 0; i--) {
      const v = s.observations[annualIdxs[i].i]?.[0];
      if (v != null) return { value: Number(v), year: annualIdxs[i].t };
    }
    return null;
  };

  const mkKey = (indicator, ageIdx, genderIdx) => {
    const k = new Array(ndims).fill(0);
    k[dimPos.INDICATOR]    = indicator;
    k[dimPos.REGION]       = V.Ukraine;
    k[dimPos.AGE]          = ageIdx;
    k[dimPos.GENDER]       = genderIdx;
    k[dimPos.TERRAIN_TYPE] = V.terrainT;
    k[dimPos.FREQ]         = V.A;
    return k.join(":");
  };

  // Per-year population — PNMI_02 has individual-year ages (Y018=idx 19, Y019=20, ...)
  const pop = { man: {}, woman: {} };
  for (let age = 18; age <= 78; age++) {
    const ai = age + 1; // Y000=1, Y001=2, ..., Y018=19
    pop.man[age]   = getLatestAnnual(series[mkKey(V.PNMI_02, ai, V.MALE)]);
    pop.woman[age] = getLatestAnnual(series[mkKey(V.PNMI_02, ai, V.FEMALE)]);
  }

  const manTotal   = Object.values(pop.man).reduce((s, x)   => s + (x?.value ?? 0), 0);
  const womanTotal = Object.values(pop.woman).reduce((s, x) => s + (x?.value ?? 0), 0);
  if (!manTotal || !womanTotal) throw new Error("Population sums are zero — dimension indices may have changed");

  const latestYear = Object.values(pop.man).find((x) => x?.year)?.year ?? "?";

  // 5-year age bands
  const BANDS = [[18,24],[25,29],[30,34],[35,39],[40,44],[45,49],[50,54],[55,59],[60,64],[65,69],[70,78]];
  const ageBands = BANDS.map(([from, to]) => {
    let m = 0, f = 0;
    for (let a = from; a <= to; a++) { m += pop.man[a]?.value ?? 0; f += pop.woman[a]?.value ?? 0; }
    return { from, to, man: +(m / manTotal).toFixed(4), woman: +(f / womanTotal).toFixed(4) };
  });

  // Total all-ages population: try PNMI_01 (_T age), else sum 18-78
  const mTot = getLatestAnnual(series[mkKey(V.PNMI_01, V.ageT, V.MALE)]);
  const fTot = getLatestAnnual(series[mkKey(V.PNMI_01, V.ageT, V.FEMALE)]);

  return {
    population: {
      man:   mTot?.value ?? manTotal,
      woman: fTot?.value ?? womanTotal,
    },
    ageBands,
    _time: latestYear,
  };
}

/* ----------------------- Wage extraction -------------------------- */
// DF_SALARY_LEVEL_OF_EMPLOYEES is small (~1,500 series); use decodeSdmxJson.

function extractWages(obs) {
  // Monthly salary, Ukraine, _T breakdown, latest period
  const relevant = obs.filter(
    (o) =>
      o.key.PERIOD_OF_TIME === "MONTH" &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.BREAKDOWN === "_T",
  );
  const t = latestTime(relevant);
  if (!t) throw new Error("No wage observations found");

  const cur = relevant.filter((o) => o.time === t);
  const bySex = {};
  for (const o of cur) {
    if (o.key.SEX === "MALE") bySex.man = o.value;
    else if (o.key.SEX === "FEMALE") bySex.woman = o.value;
  }
  if (!bySex.man || !bySex.woman) throw new Error(`Missing sex breakdown in wages at ${t}`);

  const sigma = PLACEHOLDER.income.man.sigma;
  const logMeanMan   = Math.log(bySex.man)   - (sigma * sigma) / 2;
  const logMeanWoman = Math.log(bySex.woman) - (sigma * sigma) / 2;

  // Higher-ed bonus: ln(magistracy_salary / total_salary)
  const magSex = obs.filter(
    (o) =>
      o.key.PERIOD_OF_TIME === "MONTH" &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.BREAKDOWN === "MAG_EQ" &&
      o.time === t,
  );
  const magBySex = {};
  for (const o of magSex) {
    if (o.key.SEX === "MALE") magBySex.man = o.value;
    else if (o.key.SEX === "FEMALE") magBySex.woman = o.value;
  }
  const higherEdBonus = magBySex.man && magBySex.woman
    ? +((Math.log(magBySex.man / bySex.man) + Math.log(magBySex.woman / bySex.woman)) / 2).toFixed(3)
    : PLACEHOLDER.income.man.higherEdBonus;

  return {
    income: {
      man:   { ...PLACEHOLDER.income.man,   logMean: +logMeanMan.toFixed(4),   higherEdBonus },
      woman: { ...PLACEHOLDER.income.woman, logMean: +logMeanWoman.toFixed(4), higherEdBonus },
    },
    _time: t,
  };
}

/* ------------------ Labour force extraction ----------------------- */
// DF_LABOR_FORCE_A is small (~50,000 obs); use decodeSdmxJson.

function extractEducation(obs) {
  const relevant = obs.filter(
    (o) =>
      o.key.INDICATOR === "EDUC_POPUL_PERC" &&
      o.key.BREAKDOWN_CATEGORY === "EDUC_LEVEL" &&
      (o.key.BREAKDOWN === "HIGHER" || o.key.BREAKDOWN === "BASIC_HIGHER") &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.TERRAIN_TYPE === "_T" &&
      o.key.UNITS_OF_MEASURE === "1010",
  );
  const t = latestTime(relevant);
  if (!t) return null;

  const cur = relevant.filter((o) => o.time === t);
  // Accumulate HIGHER + BASIC_HIGHER per age group per sex
  const byAge = {};
  for (const o of cur) {
    const sex = o.key.GENDER === "MALE" ? "man" : o.key.GENDER === "FEMALE" ? "woman" : null;
    if (!sex) continue;
    const ag = o.key.AGE_GROUP;
    if (!byAge[ag]) byAge[ag] = { man: 0, woman: 0 };
    byAge[ag][sex] += o.value / 100;
  }

  // Build 3 age bands: young (18-29), prime (30-64), older (65-78)
  // Y15_24 ≈ 18-29 group (students not yet graduated), Y25_64 ≈ prime
  const clamp01 = (x) => Math.min(0.99, Math.max(0.01, x));
  const mk = (g, ag1, ag2, scaleFactor) =>
    clamp01(((byAge[ag1]?.[g] ?? 0) + (byAge[ag2]?.[g] ?? 0) / 2) * (scaleFactor ?? 1));

  return {
    education: {
      man: [
        { from: 18, to: 29, p: +(byAge["Y15_24"]?.man ?? PLACEHOLDER.education.man[0].p).toFixed(3) },
        { from: 30, to: 64, p: +(byAge["Y25_64"]?.man ?? PLACEHOLDER.education.man[1].p).toFixed(3) },
        // Older cohorts had lower tertiary rates; apply 0.85 scaling factor
        { from: 65, to: 78, p: +clamp01((byAge["Y25_64"]?.man ?? PLACEHOLDER.education.man[2].p) * 0.85).toFixed(3) },
      ],
      woman: [
        { from: 18, to: 29, p: +(byAge["Y15_24"]?.woman ?? PLACEHOLDER.education.woman[0].p).toFixed(3) },
        { from: 30, to: 64, p: +(byAge["Y25_64"]?.woman ?? PLACEHOLDER.education.woman[1].p).toFixed(3) },
        { from: 65, to: 78, p: +clamp01((byAge["Y25_64"]?.woman ?? PLACEHOLDER.education.woman[2].p) * 0.85).toFixed(3) },
      ],
    },
    _time: t,
  };
}

function extractEmployment(obs) {
  const relevant = obs.filter(
    (o) =>
      o.key.INDICATOR === "EMPL_POPUL_PERC" &&
      o.key.BREAKDOWN_CATEGORY === "_T" &&
      o.key.BREAKDOWN === "_T" &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.TERRAIN_TYPE === "_T" &&
      o.key.UNITS_OF_MEASURE === "1010",
  );
  const t = latestTime(relevant);
  if (!t) return null;

  const cur = relevant.filter((o) => o.time === t);
  const byAge = {};
  for (const o of cur) {
    const sex = o.key.GENDER === "MALE" ? "man" : o.key.GENDER === "FEMALE" ? "woman" : null;
    if (!sex) continue;
    if (!byAge[o.key.AGE_GROUP]) byAge[o.key.AGE_GROUP] = {};
    byAge[o.key.AGE_GROUP][sex] = o.value / 100;
  }

  // Peak rates: men at Y30_34, women at Y40_49 (childbearing dip makes earlier ages lower)
  const mBase = byAge["Y30_34"]?.man ?? PLACEHOLDER.employment.man.base;
  const fBase = byAge["Y40_49"]?.woman ?? PLACEHOLDER.employment.woman.base;

  // youngPenalty: fit to Y15_24 rate (avg age ~20 → max(0,23-20)=3 periods)
  const mYoung = byAge["Y15_24"]?.man ?? 0.27;
  const fYoung = byAge["Y15_24"]?.woman ?? 0.22;
  const mYP = +Math.max(0.03, (mBase - mYoung) / 3).toFixed(3);
  const fYP = +Math.max(0.03, (fBase - fYoung) / 3).toFixed(3);

  // oldPenalty: fit to Y60_70 rate (avg age ~65 → max(0,65-58)=7 periods)
  const mOld = byAge["Y60_70"]?.man ?? 0.15;
  const fOld = byAge["Y60_70"]?.woman ?? 0.11;
  const mOP = +Math.max(0.02, (mBase - mOld) / 7).toFixed(3);
  const fOP = +Math.max(0.02, (fBase - fOld) / 7).toFixed(3);

  return {
    employment: {
      man:   { base: +mBase.toFixed(3), youngPenalty: mYP, oldPenalty: mOP },
      woman: { base: +fBase.toFixed(3), youngPenalty: fYP, oldPenalty: fOP },
    },
    _time: t,
  };
}

/* ------------------------- command: list --------------------------- */

async function cmdList(filter) {
  const doc = await getXml(`${API}/dataflow?detail=allstubs`);
  const flows = arr(doc?.Structure?.Structures?.Dataflows?.Dataflow);
  if (!flows.length) {
    console.log("No dataflows returned — check the API base URL.");
    return;
  }
  const f = filter?.toLowerCase();
  let shown = 0;
  for (const d of flows) {
    const id = d["@id"];
    const en = nameOf(d, "en");
    const uk = nameOf(d, "uk");
    if (f && ![id, en, uk].some((s) => String(s).toLowerCase().includes(f))) continue;
    console.log(`${id}  (v${d["@version"]})\n   EN: ${en}\n   UK: ${uk}\n`);
    shown++;
  }
  console.log(`${shown} dataflow(s)${f ? ` matching "${filter}"` : ""}.`);
}

/* ------------------------ command: inspect -------------------------- */

async function cmdInspect(dfId) {
  if (!dfId) return console.log("Usage: node etl.mjs inspect <DF_ID>");
  const doc = await getXml(`${API}/dataflow/${AGENCY}/${dfId}/latest?detail=full&references=all`);
  const S = doc?.Structure?.Structures;
  const dsd = arr(S?.DataStructures?.DataStructure)[0];
  if (!dsd) return console.log(`No DSD found for ${dfId}. Try \`list\` to confirm the id.`);

  const codelists = {};
  for (const cl of arr(S?.Codelists?.Codelist)) codelists[cl["@id"]] = cl;

  console.log(`Dataflow ${dfId} -> DSD ${dsd["@id"]}\nDimensions (in order):\n`);
  const dims = arr(dsd?.DataStructureComponents?.DimensionList?.Dimension);
  for (const dim of dims) {
    const clRef = dim?.LocalRepresentation?.Enumeration?.Ref?.["@id"];
    console.log(`  • ${dim["@id"]}${clRef ? `  -> codelist ${clRef}` : "  (no enumerated codelist)"}`);
    const cl = codelists[clRef];
    if (cl) {
      const codes = arr(cl.Code);
      codes.slice(0, 14).forEach((c) => console.log(`        ${c["@id"]} = ${nameOf(c)}`));
      if (codes.length > 14) console.log(`        … +${codes.length - 14} more codes`);
    }
  }
  const td = dsd?.DataStructureComponents?.DimensionList?.TimeDimension;
  if (td) console.log(`  • ${td["@id"]} (time)`);

  // Fetch actual dimension codes from a live data request
  console.log("\nFetching dimension codes from live data (this may take a few seconds)…");
  try {
    const url = `${API}/data/${dfId}/all/${AGENCY}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(await res.text());
    const seriesDims = data.structure?.dimensions?.series ?? [];
    if (seriesDims.length) {
      console.log("\nActual dimension codes (from live data):");
      for (const d of seriesDims) {
        const vals = (d.values ?? []).map((v) => `${v.id ?? v} = ${v.name ?? ""}`).join("\n        ");
        console.log(`  • ${d.id}\n        ${vals}`);
      }
    } else {
      console.log("  (structure not embedded in response)");
    }
  } catch (e) {
    console.log(`  (data fetch failed: ${e.message})`);
  }
  console.log("\nUse the dimension ids + codes above to fill DATAFLOWS in this file.");
}

/* ------------------------- command: build --------------------------- */

const latestTime = (obs) => obs.map((o) => o.time).sort().slice(-1)[0];

async function cmdBuild() {
  const blocks = {};
  const model = {
    meta: { generatedAt: new Date().toISOString(), apiBase: API, blocks },
    population: PLACEHOLDER.population,
    ageBands: PLACEHOLDER.ageBands,
    education: PLACEHOLDER.education,
    income: PLACEHOLDER.income,
    employment: PLACEHOLDER.employment,
    behavioral: MANUAL,
    sources: {
      population: "State Statistics Service of Ukraine (Derzhstat) — SDMX API, DF_POPULATION_STRUCTURE (2022)",
      income: "Derzhstat — DF_SALARY_LEVEL_OF_EMPLOYEES, average monthly salary of full-time employees (2020)",
      education: "Derzhstat — DF_LABOR_FORCE_A, Labour Force Survey (2021)",
      employment: "Derzhstat — DF_LABOR_FORCE_A, Labour Force Survey (2021)",
      behavioral: "WHO STEPS survey, Ukraine 2019; household surveys",
      serving: "No official public data — modelled estimate only",
      caveat:
        "Population base is an estimate for government-controlled territory; "
        + "no census since 2001 and wartime displacement add ±15-20% uncertainty.",
    },
  };

  // --- Population (large; custom direct-index extractor) ---
  const popCfg = DATAFLOWS.population;
  if (!popCfg.id.startsWith("TODO_")) {
    try {
      console.log(`• population: fetching ${popCfg.id} (~36 MB) …`);
      const raw = await fetchDataJson(popCfg.id);
      const patch = extractPopulation(raw);
      Object.assign(model, { population: patch.population, ageBands: patch.ageBands });
      blocks.population = "live";
      console.log(`  latest year: ${patch._time}, men 18-78: ${patch.population.man.toLocaleString()}`);
    } catch (err) {
      blocks.population = "placeholder (fetch failed)";
      console.warn(`  ! ${err.message}\n  Keeping placeholder for population.`);
    }
  } else {
    blocks.population = "placeholder";
    console.log("• population: id not set — keeping placeholder.");
  }

  // --- Wages (small; use decodeSdmxJson) ---
  const wageCfg = DATAFLOWS.wages;
  if (!wageCfg.id.startsWith("TODO_")) {
    try {
      console.log(`• wages: fetching ${wageCfg.id} …`);
      const raw = await fetchDataJson(wageCfg.id);
      const obs = decodeSdmxJson(raw);
      const patch = extractWages(obs);
      Object.assign(model, { income: patch.income });
      blocks.wages = "live";
      console.log(`  latest period: ${patch._time}, men avg: ${Math.exp(patch.income.man.logMean + 0.58*0.58/2).toFixed(0)} UAH/month`);
    } catch (err) {
      blocks.wages = "placeholder (fetch failed)";
      console.warn(`  ! ${err.message}\n  Keeping placeholder for wages.`);
    }
  } else {
    blocks.wages = "placeholder";
    console.log("• wages: id not set — keeping placeholder.");
  }

  // --- Labour force (small; education + employment) ---
  const lfCfg = DATAFLOWS.labourForce;
  if (!lfCfg.id.startsWith("TODO_")) {
    try {
      console.log(`• labourForce: fetching ${lfCfg.id} …`);
      const raw = await fetchDataJson(lfCfg.id);
      const obs = decodeSdmxJson(raw);

      const eduPatch = extractEducation(obs);
      if (eduPatch) {
        Object.assign(model, { education: eduPatch.education });
        blocks.education = "live";
        console.log(`  education: latest period ${eduPatch._time}`);
      } else {
        blocks.education = "placeholder (no data)";
        console.warn("  education: no EDUC_POPUL_PERC observations — keeping placeholder.");
      }

      const empPatch = extractEmployment(obs);
      if (empPatch) {
        Object.assign(model, { employment: empPatch.employment });
        blocks.employment = "live";
        console.log(`  employment: latest period ${empPatch._time}, men base: ${empPatch.employment.man.base}`);
      } else {
        blocks.employment = "placeholder (no data)";
        console.warn("  employment: no EMPL_POPUL_PERC observations — keeping placeholder.");
      }
    } catch (err) {
      blocks.education = blocks.employment = "placeholder (fetch failed)";
      console.warn(`  ! ${err.message}\n  Keeping placeholder for education/employment.`);
    }
  } else {
    blocks.education = blocks.employment = "placeholder";
    console.log("• labourForce: id not set — keeping placeholder.");
  }

  const clean = JSON.parse(JSON.stringify(model, (k, v) => (k.startsWith("_") ? undefined : v)));
  writeFileSync(OUT, JSON.stringify(clean, null, 2));
  console.log(`\nWrote ${OUT}  —  blocks: ${JSON.stringify(blocks)}`);
}

/* ------------------------------ main -------------------------------- */

const [cmd, arg] = process.argv.slice(2);
const run = { list: () => cmdList(), search: () => cmdList(arg), inspect: () => cmdInspect(arg), build: cmdBuild };
(run[cmd] || (() => console.log("Commands: list | search <word> | inspect <DF_ID> | build")))()
  .catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
