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
     3. Paste the real IDs + codes into the DATAFLOWS config below.
     4. `build`. Blocks still marked TODO fall back to PLACEHOLDER values,
        so the script always produces a valid, app-ready model.json.

   The API endpoint patterns below are taken from the official docs:
   https://stat.gov.ua/en/development-api/step-by-step-example
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
const OUT = "model.json";
const LANG = "en"; // "en" or "uk" — language used when printing names

// Dataflows to pull. Replace the TODO_* ids with the real ones you find
// via `list` / `inspect`. Any block left as TODO_* keeps its PLACEHOLDER.
const DATAFLOWS = {
  population: {
    id: "TODO_POPULATION_BY_SEX_AGE", // e.g. DF_POPULATION...
    version: "latest",
    key: "all", // or e.g. "*.*.*" — one slot per dimension (see `inspect`)
    // after `inspect`, set the dimension ids and the codes used for sex:
    dim: { sex: "SEX", age: "AGE" },
    code: { male: "M", female: "F" },
  },
  wages: {
    id: "TODO_AVERAGE_MONTHLY_WAGE",
    version: "latest",
    key: "all",
    dim: { sex: "SEX" },
    code: { male: "M", female: "F" },
  },
  education: {
    id: "TODO_EDUCATION_ATTAINMENT_BY_AGE_SEX",
    version: "latest",
    key: "all",
    dim: { sex: "SEX", age: "AGE", level: "EDU_LEVEL" },
    code: { male: "M", female: "F", higher: "HIGHER" }, // verify via `inspect`
  },
};

/* ---- Values NOT available from Derzhstat SDMX — entered by hand. ----
   Sources: WHO STEPS survey (Ukraine, 2019); household surveys.
   Update these from the cited reports; the ETL just copies them through. */
const MANUAL = {
  height: {
    // STEPS 2019 measured height — VERIFY exact means/SDs in the report.
    man: { mean: 176.0, sd: 7.0 },
    woman: { mean: 165.5, sd: 6.2 },
  },
  smoking: {
    man: 0.503, // STEPS 2019: 50.3% of men were current tobacco smokers
    woman: 0.167, // STEPS 2019: 16.7% of women
    higherEdMultiplier: 0.72, // smoking is lower among the higher-educated
  },
  teetotal: {
    // STEPS 2019: ~2/3 of men and ~1/2 of women drank in the last 30 days;
    // "never drinks" is stricter — these are conservative estimates.
    man: 0.22,
    woman: 0.42,
  },
  kids: { midAge: 30, steepness: 0.28, manFactor: 0.92, womanFactor: 0.97 },
  ownsHome: { base: 0.18, ageSlope: 0.011, incomeBonus: 0.08 },
  hasCar: { incomeMid: 25000, incomeScale: 22000, manFactor: 1.05, womanFactor: 0.9 },
  // No official public data exists — military statistics are classified.
  serving: { manPeakAge: 37, manPeakProb: 0.14, manSpread: 420, womanProb: 0.02 },
};

/* ---- Fallback values, used for any block whose dataflow is still TODO.
   These mirror the prototype's current placeholders. ---- */
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
    man: [{ from: 18, to: 29, p: 0.46 }, { from: 30, to: 44, p: 0.42 }, { from: 45, to: 78, p: 0.34 }],
    woman: [{ from: 18, to: 29, p: 0.55 }, { from: 30, to: 44, p: 0.5 }, { from: 45, to: 78, p: 0.4 }],
  },
  income: {
    man: { logMean: 9.95, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
    woman: { logMean: 9.77, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
  },
  employment: {
    man: { base: 0.66, youngPenalty: 0.04, oldPenalty: 0.045 },
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

// The Derzhstat data endpoint only responds to SDMX-JSON; generic/compact XML return 500.
// SDMX-JSON encodes series keys as colon-separated dimension-value indices ("0:1:2:0:0:0").
// This helper fetches data + its embedded structure, then returns observations as flat objects:
//   { key: { DIM_ID: "CODE_VALUE", ... }, time: "YYYY", value: number }
async function fetchObservationsSdmxJson(cfg, retries = 3) {
  const url = `${API}/data/${cfg.id}/all/${AGENCY}`;
  let data = null;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 4000 * attempt));
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.sdmx.data+json;version=1.0" },
      signal: AbortSignal.timeout(25000),
    }).catch((e) => { lastErr = e; return null; });
    if (!res?.ok) { lastErr = lastErr ?? new Error(`HTTP ${res?.status} (attempt ${attempt})`); continue; }
    const parsed = JSON.parse(await res.text());
    if (!parsed.dataSets) { lastErr = new Error("No dataSets in response"); continue; }
    data = parsed;
    cacheWrite(cfg.id, data);
    break;
  }

  if (!data) {
    const cached = cacheRead(cfg.id);
    if (cached) {
      console.warn(`  API unavailable (${lastErr?.message}) — using cached response for ${cfg.id}`);
      data = cached;
    } else {
      throw lastErr ?? new Error(`fetchObservationsSdmxJson failed for ${cfg.id}`);
    }
  }

  return decodeSdmxJson(data);
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

  // Attempt a live data fetch to show actual dimension values (the DSD lacks codelists)
  console.log("\nFetching sample data to discover actual dimension codes (this may take a few seconds)…");
  try {
    const url = `${API}/data/${dfId}/all/${AGENCY}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.sdmx.data+json;version=1.0" },
      signal: AbortSignal.timeout(20000),
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
      console.log("  (structure not embedded in response — dimension codes unknown)");
    }
  } catch (e) {
    console.log(`  (data fetch failed: ${e.message})`);
  }
  console.log("\nUse the dimension ids + codes above to fill DATAFLOWS in this file.");
}

/* ------------------------- command: build --------------------------- */

async function fetchObservations(cfg) {
  return fetchObservationsSdmxJson(cfg);
}

const latestTime = (obs) => obs.map((o) => o.time).sort().slice(-1)[0];

// --- transforms: shape Derzhstat observations into model blocks ---
// Each has a TODO where you confirm code names against `inspect` output.

function transformPopulation(obs, cfg) {
  const t = latestTime(obs);
  const cur = obs.filter((o) => o.time === t);
  const sum = (sexCode) =>
    cur.filter((o) => o.key[cfg.dim.sex] === sexCode).reduce((a, o) => a + o.value, 0);
  // TODO: Derzhstat may report population in thousands — multiply if so.
  const man = sum(cfg.code.male);
  const woman = sum(cfg.code.female);
  return { population: { man, woman }, _time: t };
}

function transformWages(obs, cfg) {
  const t = latestTime(obs);
  const cur = obs.filter((o) => o.time === t);
  const avg = cur.reduce((a, o) => a + o.value, 0) / Math.max(1, cur.length);
  // lognormal: mean = exp(mu + sigma^2/2)  ->  mu = ln(mean) - sigma^2/2
  const sigma = PLACEHOLDER.income.man.sigma;
  const logMean = Math.log(avg) - (sigma * sigma) / 2;
  return {
    income: {
      man: { ...PLACEHOLDER.income.man, logMean },
      woman: { ...PLACEHOLDER.income.woman, logMean: logMean - 0.18 }, // pay-gap offset
    },
    _calibratedFromAvgWage: avg,
    _time: t,
  };
}

function transformEducation(obs, cfg) {
  // TODO: confirm the EDU_LEVEL code(s) that mean "higher education".
  // Produces P(higher ed) per age band per sex.
  const t = latestTime(obs);
  const cur = obs.filter((o) => o.time === t);
  console.log("    education transform is a scaffold — adapt to the real AGE/EDU_LEVEL codes.");
  return { education: PLACEHOLDER.education, _time: t, _scaffold: true };
}

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
      population: "State Statistics Service of Ukraine (Derzhstat) — SDMX API",
      income: "Derzhstat — average monthly wage",
      education: "Derzhstat / Labour Force Survey",
      behavioral: "WHO STEPS survey, Ukraine 2019; household surveys",
      serving: "No official public data — modelled estimate only",
      caveat: "Population base is an estimate for government-controlled territory; "
        + "no census since 2001 and wartime displacement add ±15-20% uncertainty.",
    },
  };

  for (const [name, cfg] of Object.entries(DATAFLOWS)) {
    if (cfg.id.startsWith("TODO_")) {
      blocks[name] = "placeholder";
      console.log(`• ${name}: id not set — keeping placeholder.`);
      continue;
    }
    try {
      console.log(`• ${name}: fetching ${cfg.id} …`);
      const obs = await fetchObservations(cfg);
      let patch;
      if (name === "population") patch = transformPopulation(obs, cfg);
      else if (name === "wages") patch = transformWages(obs, cfg);
      else if (name === "education") patch = transformEducation(obs, cfg);
      Object.assign(model, patch);
      blocks[name] = patch?._scaffold ? "scaffold" : "live";
      console.log(`  ${obs.length} observations, latest period ${patch?._time ?? "?"}.`);
    } catch (err) {
      blocks[name] = "placeholder (fetch failed)";
      console.warn(`  ! ${err.message}\n  Keeping placeholder for "${name}".`);
    }
  }

  // strip internal _fields before writing
  const clean = JSON.parse(JSON.stringify(model, (k, v) => (k.startsWith("_") ? undefined : v)));
  writeFileSync(OUT, JSON.stringify(clean, null, 2));
  console.log(`\nWrote ${OUT}  —  blocks: ${JSON.stringify(blocks)}`);
}

/* ------------------------------ main -------------------------------- */

const [cmd, arg] = process.argv.slice(2);
const run = { list: () => cmdList(), search: () => cmdList(arg), inspect: () => cmdInspect(arg), build: cmdBuild };
(run[cmd] || (() => console.log("Commands: list | search <word> | inspect <DF_ID> | build")))()
  .catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
