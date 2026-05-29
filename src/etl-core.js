// Pure functions extracted from etl.mjs for testability.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";

export const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function cacheRead(cacheDir, dfId) {
  if (!SAFE_ID.test(dfId)) throw new Error(`Invalid cache ID: "${dfId}"`);
  const p = `${cacheDir}/${dfId}.json`;
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed.dataSets) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function cacheWrite(cacheDir, dfId, data) {
  if (!SAFE_ID.test(dfId)) throw new Error(`Invalid cache ID: "${dfId}"`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(`${cacheDir}/${dfId}.json`, JSON.stringify(data));
}

// Decode a raw SDMX-JSON payload into flat observation objects.
// Returns [{ key: { DIM_ID: "CODE" }, time: "YYYY", value: number }]
export function decodeSdmxJson(data) {
  const seriesDims = data.structure?.dimensions?.series ?? [];
  const obsDims    = data.structure?.dimensions?.observation ?? [];
  const dimValues  = seriesDims.map((d) => ({
    id: d.id,
    values: (d.values ?? []).map((v) => v.id ?? String(v)),
  }));
  const timeDim    = obsDims[0];
  const timeValues = (timeDim?.values ?? []).map((v) => v.id ?? String(v));

  const out = [];
  for (const ds of data.dataSets ?? []) {
    for (const [seriesKey, series] of Object.entries(ds.series ?? {})) {
      const keyParts = seriesKey.split(":").map(Number);
      const key = {};
      for (let i = 0; i < dimValues.length; i++) {
        key[dimValues[i].id] = dimValues[i].values[keyParts[i]] ?? String(keyParts[i]);
      }
      for (const [obsIdx, obsArr] of Object.entries(series.observations ?? {})) {
        out.push({ key, time: timeValues[Number(obsIdx)] ?? obsIdx, value: Number(obsArr[0]) });
      }
    }
  }
  return out;
}

// Returns the latest time string across an array of decoded observations.
export function latestTime(obs) {
  return obs.map((o) => o.time).sort().slice(-1)[0];
}

/* =======================================================================
   DF_POPULATION_STRUCTURE extractor
   ~36 MB response — uses direct series-key lookup to avoid materialising
   millions of observation objects via decodeSdmxJson.

   Expected dimensions (in order): INDICATOR, REGION, AGE, GENDER,
     TERRAIN_TYPE, FREQ.
   Age-specific counts live under INDICATOR=PNMI_02 (constant population).
   PNMI_01 (resident pop) exists only for AGE=_T and is used for totals.

   Returns { population, ageBands, _time } or null on failure.
   ======================================================================= */
export function extractPopulation(raw) {
  const dims = raw?.structure?.dimensions?.series;
  const timeDims = raw?.structure?.dimensions?.observation;
  if (!dims || !raw?.dataSets?.[0]?.series) {
    console.warn("extractPopulation: missing structure/dataSets in response");
    return null;
  }

  const times = (timeDims?.[0]?.values ?? []).map((v) => v.id ?? String(v));
  const annualIdxs = times
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => /^\d{4}$/.test(t));
  if (!annualIdxs.length) {
    console.warn("extractPopulation: no annual time periods in response");
    return null;
  }

  // Build position map (dim ID → array position)
  const dimPos = Object.fromEntries(dims.map((d, i) => [d.id, i]));

  // Build value-index lookup for each dimension code we need
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

  const missing = Object.entries(V)
    .filter(([, v]) => v === -1)
    .map(([k]) => k);
  if (missing.length) {
    console.warn(
      `extractPopulation: missing required dimension codes: ${missing.join(", ")}. ` +
      "Run 'node etl.mjs inspect DF_POPULATION_STRUCTURE' to verify the API schema.",
    );
    return null;
  }

  // Build age code → dimension-value index map (avoids hardcoding age+1 offset)
  const ageCodeToIdx = Object.fromEntries(
    (dims[dimPos.AGE]?.values ?? []).map((v, i) => [v.id ?? String(v), i]),
  );

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

  const pop = { man: {}, woman: {} };
  for (let age = 18; age <= 78; age++) {
    const ageCode = `Y${String(age).padStart(3, "0")}`;
    const ai = ageCodeToIdx[ageCode];
    if (ai == null) continue; // age code absent in this response
    pop.man[age]   = getLatestAnnual(series[mkKey(V.PNMI_02, ai, V.MALE)]);
    pop.woman[age] = getLatestAnnual(series[mkKey(V.PNMI_02, ai, V.FEMALE)]);
  }

  const manTotal   = Object.values(pop.man).reduce((s, x) => s + (x?.value ?? 0), 0);
  const womanTotal = Object.values(pop.woman).reduce((s, x) => s + (x?.value ?? 0), 0);
  if (!manTotal || !womanTotal) {
    console.warn(
      `extractPopulation: could not sum per-age observations (men=${manTotal}, women=${womanTotal}). ` +
      "Check that PNMI_02 series exist and dimension codes are correct.",
    );
    return null;
  }

  const latestYear = Object.values(pop.man).find((x) => x?.year)?.year ?? "?";

  const BANDS = [
    [18,24],[25,29],[30,34],[35,39],[40,44],
    [45,49],[50,54],[55,59],[60,64],[65,69],[70,78],
  ];
  const ageBands = BANDS.map(([from, to]) => {
    let m = 0, f = 0;
    for (let a = from; a <= to; a++) { m += pop.man[a]?.value ?? 0; f += pop.woman[a]?.value ?? 0; }
    return { from, to, man: +(m / manTotal).toFixed(4), woman: +(f / womanTotal).toFixed(4) };
  });

  // All-ages totals: use PNMI_01 _T where available, else fall back to 18-78 sum
  const mTot = getLatestAnnual(series[mkKey(V.PNMI_01, V.ageT, V.MALE)]);
  const fTot = getLatestAnnual(series[mkKey(V.PNMI_01, V.ageT, V.FEMALE)]);

  return {
    population: { man: mTot?.value ?? manTotal, woman: fTot?.value ?? womanTotal },
    ageBands,
    _time: latestYear,
  };
}

/* =======================================================================
   DF_SALARY_LEVEL_OF_EMPLOYEES extractor (4-year Labour Cost Survey).
   Expects decoded obs from decodeSdmxJson.
   Returns { income, _time } or null on failure.
   ======================================================================= */
export function extractWages(obs, sigmaOverride = 0.58) {
  const relevant = obs.filter(
    (o) =>
      o.key.PERIOD_OF_TIME === "MONTH" &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.BREAKDOWN === "_T",
  );
  const t = latestTime(relevant);
  if (!t) {
    const found = [...new Set(obs.map((o) => o.key.PERIOD_OF_TIME))];
    console.warn(
      `extractWages: no observations matched PERIOD_OF_TIME=MONTH, BREAKDOWN=_T. ` +
      `Found PERIOD_OF_TIME values: ${found.join(", ")}`,
    );
    return null;
  }

  const cur = relevant.filter((o) => o.time === t);
  const bySex = {};
  for (const o of cur) {
    if (o.key.SEX === "MALE")   bySex.man   = o.value;
    if (o.key.SEX === "FEMALE") bySex.woman = o.value;
  }
  if (!bySex.man || !bySex.woman) {
    console.warn(
      `extractWages: missing sex breakdown at ${t}: ` +
      `man=${bySex.man}, woman=${bySex.woman}`,
    );
    return null;
  }

  const sigma = sigmaOverride;
  const logMeanMan   = Math.log(bySex.man)   - (sigma * sigma) / 2;
  const logMeanWoman = Math.log(bySex.woman) - (sigma * sigma) / 2;

  // Higher-ed bonus: average of ln(master_salary / total_salary) across sexes
  const magObs = obs.filter(
    (o) =>
      o.key.PERIOD_OF_TIME === "MONTH" &&
      o.key.REGION === "UA00000000000000000" &&
      o.key.BREAKDOWN === "MAG_EQ" &&
      o.time === t,
  );
  const mag = {};
  for (const o of magObs) {
    if (o.key.SEX === "MALE")   mag.man   = o.value;
    if (o.key.SEX === "FEMALE") mag.woman = o.value;
  }
  const higherEdBonus =
    mag.man && mag.woman
      ? +((Math.log(mag.man / bySex.man) + Math.log(mag.woman / bySex.woman)) / 2).toFixed(3)
      : 0.42; // WHO-calibrated fallback

  return {
    income: {
      man:   { logMean: +logMeanMan.toFixed(4),   sigma, higherEdBonus, agePeak: 41, ageCurvature: 0.00065 },
      woman: { logMean: +logMeanWoman.toFixed(4), sigma, higherEdBonus, agePeak: 41, ageCurvature: 0.00065 },
    },
    _time: t,
  };
}

/* =======================================================================
   DF_ENTERPRISE_LABOR_STATISTICS extractor (monthly enterprise survey).
   Has data through the current year (e.g. 2026-M04).
   Dimensions: INDICATOR, REGION, BASE, NACE, BREAKDOWN_CATEGORY,
               BREAKDOWN, FREQ.

   Strategy: take the latest monthly total (FREQ=M, BREAKDOWN=_T) for
   all Ukraine / all sectors (NACE=_T) as the wage level baseline, then
   apply the sex ratio from the most recent quarterly breakdown to produce
   sex-specific estimates.  The higherEdBonus of 0.333 is calibrated from
   the 2020 Labour Cost Survey and carried forward unchanged — no education
   breakdown exists in this dataflow.

   Returns { income, _time } or null on failure.
   ======================================================================= */
export function extractWagesEnterprise(obs, sigmaOverride = 0.58) {
  const UA = "UA00000000000000000";

  // Latest monthly total: all Ukraine, all sectors, SEX breakdown category, total sex
  const mthTotalObs = obs.filter(
    (o) =>
      o.key.INDICATOR          === "AVG_MTH_SALARY_UAH" &&
      o.key.REGION             === UA &&
      o.key.NACE               === "_T" &&
      o.key.BREAKDOWN_CATEGORY === "SEX" &&
      o.key.BREAKDOWN          === "_T" &&
      o.key.FREQ               === "M",
  );
  const latestMonth = latestTime(mthTotalObs);
  if (!latestMonth) {
    console.warn(
      "extractWagesEnterprise: no monthly total observations found. " +
      `Found INDICATOR values: ${[...new Set(obs.map((o) => o.key.INDICATOR))].join(", ")}`,
    );
    return null;
  }
  const totalSalary = mthTotalObs.find((o) => o.time === latestMonth)?.value;

  // Sex ratio from the most recent quarterly breakdown (more recent than annual)
  const sexRatioObs = (freq) =>
    obs.filter(
      (o) =>
        o.key.INDICATOR          === "AVG_MTH_SALARY_UAH" &&
        o.key.REGION             === UA &&
        o.key.NACE               === "_T" &&
        o.key.BREAKDOWN_CATEGORY === "SEX" &&
        (o.key.BREAKDOWN === "M" || o.key.BREAKDOWN === "F" || o.key.BREAKDOWN === "_T") &&
        o.key.FREQ               === freq,
    );

  const deriveSexRatio = (pool) => {
    const t = latestTime(pool);
    if (!t) return null;
    const cur    = pool.filter((o) => o.time === t);
    const qTotal = cur.find((o) => o.key.BREAKDOWN === "_T")?.value;
    const qMale  = cur.find((o) => o.key.BREAKDOWN === "M")?.value;
    const qFem   = cur.find((o) => o.key.BREAKDOWN === "F")?.value;
    if (!qTotal || !qMale || !qFem) return null;
    return { male: qMale / qTotal, female: qFem / qTotal, ratioTime: t };
  };

  const ratio = deriveSexRatio(sexRatioObs("Q")) ?? deriveSexRatio(sexRatioObs("A"));
  if (!ratio) {
    console.warn("extractWagesEnterprise: could not derive male/female salary ratio from quarterly or annual data");
    return null;
  }

  const manSalary   = totalSalary * ratio.male;
  const womanSalary = totalSalary * ratio.female;
  const sigma = sigmaOverride;
  // higherEdBonus: calibrated from 2020 Labour Cost Survey (DF_SALARY_LEVEL_OF_EMPLOYEES)
  const higherEdBonus = 0.333;

  return {
    income: {
      man:   { logMean: +(Math.log(manSalary)   - (sigma * sigma) / 2).toFixed(4), sigma, higherEdBonus, agePeak: 41, ageCurvature: 0.00065 },
      woman: { logMean: +(Math.log(womanSalary) - (sigma * sigma) / 2).toFixed(4), sigma, higherEdBonus, agePeak: 41, ageCurvature: 0.00065 },
    },
    _time: latestMonth,
  };
}

/* =======================================================================
   DF_LABOR_FORCE_A — education extractor
   Returns { education, _time } or null on failure.
   ======================================================================= */
export function extractEducation(obs) {
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
  if (!t) {
    const foundIndicators = [...new Set(obs.map((o) => o.key.INDICATOR))].join(", ");
    const foundBreakdowns = [...new Set(obs.map((o) => o.key.BREAKDOWN))].join(", ");
    console.warn(
      "extractEducation: no observations matched filters. " +
      `Found INDICATOR values: ${foundIndicators} | BREAKDOWN values: ${foundBreakdowns}`,
    );
    return null;
  }

  const cur = relevant.filter((o) => o.time === t);
  const byAge = {};
  for (const o of cur) {
    const sex = o.key.GENDER === "MALE" ? "man" : o.key.GENDER === "FEMALE" ? "woman" : null;
    if (!sex) continue;
    const ag = o.key.AGE_GROUP;
    if (!byAge[ag]) byAge[ag] = { man: 0, woman: 0 };
    byAge[ag][sex] += o.value / 100;
  }

  const clamp01 = (x) => Math.min(0.99, Math.max(0.01, x));

  return {
    education: {
      man: [
        { from: 18, to: 29, p: +(byAge["Y15_24"]?.man ?? 0.46).toFixed(3) },
        { from: 30, to: 64, p: +(byAge["Y25_64"]?.man ?? 0.42).toFixed(3) },
        { from: 65, to: 78, p: +clamp01((byAge["Y25_64"]?.man ?? 0.34) * 0.85).toFixed(3) },
      ],
      woman: [
        { from: 18, to: 29, p: +(byAge["Y15_24"]?.woman ?? 0.55).toFixed(3) },
        { from: 30, to: 64, p: +(byAge["Y25_64"]?.woman ?? 0.50).toFixed(3) },
        { from: 65, to: 78, p: +clamp01((byAge["Y25_64"]?.woman ?? 0.40) * 0.85).toFixed(3) },
      ],
    },
    _time: t,
  };
}

/* =======================================================================
   DF_LABOR_FORCE_A — employment extractor
   Derives base rate and penalty coefficients from age-band observations.
   Employment formula (used by the app):
     pEmp = base - max(0, 23-age)*youngPenalty - max(0, age-58)*oldPenalty
   Returns { employment, _time } or null on failure.
   ======================================================================= */
export function extractEmployment(obs) {
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
  if (!t) {
    const foundIndicators = [...new Set(obs.map((o) => o.key.INDICATOR))].join(", ");
    console.warn(
      "extractEmployment: no observations matched filters. " +
      `Found INDICATOR values: ${foundIndicators}`,
    );
    return null;
  }

  const cur = relevant.filter((o) => o.time === t);
  const byAge = {};
  for (const o of cur) {
    const sex = o.key.GENDER === "MALE" ? "man" : o.key.GENDER === "FEMALE" ? "woman" : null;
    if (!sex) continue;
    if (!byAge[o.key.AGE_GROUP]) byAge[o.key.AGE_GROUP] = {};
    byAge[o.key.AGE_GROUP][sex] = o.value / 100;
  }

  const mBase = byAge["Y30_34"]?.man   ?? 0.66; // peak: men 30-34
  const fBase = byAge["Y40_49"]?.woman ?? 0.58; // peak: women 40-49

  // youngPenalty: from Y15_24 rate. Avg age ≈ 20 → max(0, 23-20)=3 steps below base.
  const mYP = +Math.max(0.03, (mBase - (byAge["Y15_24"]?.man   ?? 0.27)) / 3).toFixed(3);
  const fYP = +Math.max(0.03, (fBase - (byAge["Y15_24"]?.woman ?? 0.22)) / 3).toFixed(3);

  // oldPenalty: from Y60_70 rate. Avg age ≈ 65 → max(0, 65-58)=7 steps below base.
  const mOP = +Math.max(0.02, (mBase - (byAge["Y60_70"]?.man   ?? 0.15)) / 7).toFixed(3);
  const fOP = +Math.max(0.02, (fBase - (byAge["Y60_70"]?.woman ?? 0.11)) / 7).toFixed(3);

  return {
    employment: {
      man:   { base: +mBase.toFixed(3), youngPenalty: mYP, oldPenalty: mOP },
      woman: { base: +fBase.toFixed(3), youngPenalty: fYP, oldPenalty: fOP },
    },
    _time: t,
  };
}
