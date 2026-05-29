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

   NOTE: The data endpoint requires Accept: application/json (not SDMX-JSON).
   Tested against Derzhstat API v2.1 — last verified 2026-05.
   ===================================================================== */

import { writeFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import {
  cacheRead as _cacheRead,
  cacheWrite as _cacheWrite,
  decodeSdmxJson,
  latestTime,
  extractPopulation,
  extractWages,
  extractEducation,
  extractEmployment,
} from "./src/etl-core.js";

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
    // Dimensions: INDICATOR, REGION, AGE, GENDER, TERRAIN_TYPE, FREQ
    // Age-specific counts only exist under INDICATOR=PNMI_02 (constant population).
  },
  wages: {
    id: "DF_SALARY_LEVEL_OF_EMPLOYEES",
    // Dimensions: INDICATOR, PERIOD_OF_TIME, SEX, REGION, BREAKDOWN_CATEGORY, BREAKDOWN, FREQ
  },
  labourForce: {
    id: "DF_LABOR_FORCE_A",
    // Dimensions: INDICATOR, REGION, BREAKDOWN_CATEGORY, BREAKDOWN, AGE_GROUP,
    //             GENDER, TERRAIN_TYPE, UNITS_OF_MEASURE, FREQ
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
  teetotal: { man: 0.22, woman: 0.42 },
  kids: { midAge: 30, steepness: 0.28, manFactor: 0.92, womanFactor: 0.97 },
  ownsHome: { base: 0.18, ageSlope: 0.011, incomeBonus: 0.08 },
  hasCar: { incomeMid: 25000, incomeScale: 22000, manFactor: 1.05, womanFactor: 0.9 },
  serving: { manPeakAge: 37, manPeakProb: 0.14, manSpread: 420, womanProb: 0.02 },
};

/* ---- Fallback values used when a dataflow fetch or extraction fails. ---- */
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

// Fetch a dataflow as JSON (Accept: application/json — only format Derzhstat serves).
// Caches successful responses; falls back to disk cache on API failure.
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
  console.log("\nUse the dimension ids + codes above to fill the extractors in src/etl-core.js.");
}

/* ------------------------- command: build --------------------------- */

async function cmdBuild() {
  const blocks = {};
  const model = {
    meta: { generatedAt: new Date().toISOString(), apiBase: API, blocks },
    population:  PLACEHOLDER.population,
    ageBands:    PLACEHOLDER.ageBands,
    education:   PLACEHOLDER.education,
    income:      PLACEHOLDER.income,
    employment:  PLACEHOLDER.employment,
    behavioral:  MANUAL,
    sources: {
      population:  "State Statistics Service of Ukraine (Derzhstat) — SDMX API, DF_POPULATION_STRUCTURE (2022)",
      income:      "Derzhstat — DF_SALARY_LEVEL_OF_EMPLOYEES, average monthly salary of full-time employees (2020)",
      education:   "Derzhstat — DF_LABOR_FORCE_A, Labour Force Survey (2021)",
      employment:  "Derzhstat — DF_LABOR_FORCE_A, Labour Force Survey (2021)",
      behavioral:  "WHO STEPS survey, Ukraine 2019; household surveys",
      serving:     "No official public data — modelled estimate only",
      caveat:
        "Population base is an estimate for government-controlled territory; "
        + "no census since 2001 and wartime displacement add ±15-20% uncertainty.",
    },
  };

  // --- Population (large ~36 MB; direct-index extractor) ---
  try {
    console.log(`• population: fetching ${DATAFLOWS.population.id} (~36 MB) …`);
    const raw = await fetchDataJson(DATAFLOWS.population.id);
    const patch = extractPopulation(raw);
    if (patch) {
      model.population = patch.population;
      model.ageBands   = patch.ageBands;
      blocks.population = "live";
      console.log(`  latest year: ${patch._time}, men 18-78: ${patch.population.man.toLocaleString()}`);
    } else {
      blocks.population = "placeholder (extraction failed)";
      console.warn("  population: extraction returned null — keeping placeholder.");
    }
  } catch (err) {
    blocks.population = "placeholder (fetch failed)";
    console.warn(`  ! ${err.message}\n  Keeping placeholder for population.`);
  }

  // --- Wages (small ~1,500 series; decoded via decodeSdmxJson) ---
  try {
    console.log(`• wages: fetching ${DATAFLOWS.wages.id} …`);
    const raw = await fetchDataJson(DATAFLOWS.wages.id);
    const obs = decodeSdmxJson(raw);
    const patch = extractWages(obs);
    if (patch) {
      model.income = patch.income;
      blocks.wages = "live";
      console.log(`  latest period: ${patch._time}, men avg: ${Math.exp(patch.income.man.logMean + 0.58 * 0.58 / 2).toFixed(0)} UAH/month`);
    } else {
      blocks.wages = "placeholder (extraction failed)";
      console.warn("  wages: extraction returned null — keeping placeholder.");
    }
  } catch (err) {
    blocks.wages = "placeholder (fetch failed)";
    console.warn(`  ! ${err.message}\n  Keeping placeholder for wages.`);
  }

  // --- Labour force (small ~7,000 series; education + employment) ---
  try {
    console.log(`• labourForce: fetching ${DATAFLOWS.labourForce.id} …`);
    const raw = await fetchDataJson(DATAFLOWS.labourForce.id);
    const obs = decodeSdmxJson(raw);

    const eduPatch = extractEducation(obs);
    if (eduPatch) {
      model.education = eduPatch.education;
      blocks.education = "live";
      console.log(`  education: latest period ${eduPatch._time}`);
    } else {
      blocks.education = "placeholder (extraction failed)";
      console.warn("  education: extraction returned null — keeping placeholder.");
    }

    const empPatch = extractEmployment(obs);
    if (empPatch) {
      model.employment = empPatch.employment;
      blocks.employment = "live";
      console.log(`  employment: latest period ${empPatch._time}, men base: ${empPatch.employment.man.base}`);
    } else {
      blocks.employment = "placeholder (extraction failed)";
      console.warn("  employment: extraction returned null — keeping placeholder.");
    }
  } catch (err) {
    blocks.education = blocks.employment = "placeholder (fetch failed)";
    console.warn(`  ! ${err.message}\n  Keeping placeholder for education/employment.`);
  }

  const clean = JSON.parse(JSON.stringify(model, (k, v) => (k.startsWith("_") ? undefined : v)));
  writeFileSync(OUT, JSON.stringify(clean, null, 2));
  console.log(`\nWrote ${OUT}  —  blocks: ${JSON.stringify(blocks)}`);
}

/* ------------------------------ main -------------------------------- */

// Guard ensures this code runs only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const run = { list: () => cmdList(), search: () => cmdList(arg), inspect: () => cmdInspect(arg), build: cmdBuild };
  (run[cmd] || (() => console.log("Commands: list | search <word> | inspect <DF_ID> | build")))()
    .catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
}
