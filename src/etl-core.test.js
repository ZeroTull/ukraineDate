import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheRead, cacheWrite, decodeSdmxJson,
  latestTime,
  extractPopulation, extractWages, extractEducation, extractEmployment,
} from "./etl-core.js";

// ---- cache helpers ----

const TMP = join(tmpdir(), `etl-test-${process.pid}`);
beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("cacheWrite / cacheRead round-trip", () => {
  it("writes and reads back a valid payload", () => {
    const payload = { dataSets: [{ series: {} }] };
    cacheWrite(TMP, "DF_TEST", payload);
    expect(cacheRead(TMP, "DF_TEST")).toEqual(payload);
  });

  it("returns null for a non-existent file", () => {
    expect(cacheRead(TMP, "MISSING")).toBeNull();
  });

  it("returns null and does not throw for a corrupted file", () => {
    writeFileSync(join(TMP, "BAD.json"), "not valid json{{");
    expect(cacheRead(TMP, "BAD")).toBeNull();
  });

  it("returns null when dataSets field is absent", () => {
    cacheWrite(TMP, "NO_DS", { header: {} });
    expect(cacheRead(TMP, "NO_DS")).toBeNull();
  });
});

describe("cache ID validation", () => {
  it("throws on path-traversal in cacheRead", () => {
    expect(() => cacheRead(TMP, "../../etc/passwd")).toThrow("Invalid cache ID");
  });

  it("throws on path-traversal in cacheWrite", () => {
    expect(() => cacheWrite(TMP, "../escape", {})).toThrow("Invalid cache ID");
  });

  it("throws on ID with special chars in cacheRead", () => {
    expect(() => cacheRead(TMP, "foo bar")).toThrow("Invalid cache ID");
  });

  it("accepts valid ID patterns", () => {
    const payload = { dataSets: [{}] };
    expect(() => cacheWrite(TMP, "DF_POPULATION_STRUCTURE", payload)).not.toThrow();
    expect(() => cacheWrite(TMP, "DF-123", payload)).not.toThrow();
  });
});

// ---- decodeSdmxJson ----

const SAMPLE_PAYLOAD = {
  structure: {
    dimensions: {
      series: [
        { id: "GENDER", values: [{ id: "M" }, { id: "F" }] },
        { id: "AGE",    values: [{ id: "18-24" }, { id: "25-34" }] },
      ],
      observation: [
        { id: "TIME_PERIOD", values: [{ id: "2022" }, { id: "2023" }] },
      ],
    },
  },
  dataSets: [{
    series: {
      "0:0": { observations: { "0": [1000], "1": [1100] } },
      "1:1": { observations: { "1": [2000] } },
    },
  }],
};

describe("decodeSdmxJson — with embedded structure", () => {
  it("decodes dimension codes from indices", () => {
    const obs = decodeSdmxJson(SAMPLE_PAYLOAD);
    expect(obs).toContainEqual({ key: { GENDER: "M", AGE: "18-24" }, time: "2022", value: 1000 });
    expect(obs).toContainEqual({ key: { GENDER: "M", AGE: "18-24" }, time: "2023", value: 1100 });
    expect(obs).toContainEqual({ key: { GENDER: "F", AGE: "25-34" }, time: "2023", value: 2000 });
  });

  it("returns the correct total observation count", () => {
    expect(decodeSdmxJson(SAMPLE_PAYLOAD)).toHaveLength(3);
  });
});

describe("decodeSdmxJson — without embedded structure (Derzhstat omits it)", () => {
  const noStructure = {
    dataSets: [{
      series: {
        "0:1": { observations: { "0": [500] } },
      },
    }],
  };

  it("falls back to string index codes without throwing", () => {
    const obs = decodeSdmxJson(noStructure);
    expect(obs).toHaveLength(1);
    expect(obs[0].key).toEqual({});   // no dims → empty key
    expect(obs[0].time).toBe("0");    // time index as string
    expect(obs[0].value).toBe(500);
  });
});

describe("decodeSdmxJson — edge cases", () => {
  it("returns empty array for empty dataSets", () => {
    expect(decodeSdmxJson({ dataSets: [] })).toEqual([]);
  });

  it("returns empty array when dataSets is absent", () => {
    expect(decodeSdmxJson({})).toEqual([]);
  });

  it("uses string fallback when dim index exceeds values array", () => {
    const payload = {
      structure: {
        dimensions: {
          series: [{ id: "X", values: [{ id: "A" }] }],
          observation: [{ id: "TIME_PERIOD", values: [{ id: "2024" }] }],
        },
      },
      dataSets: [{ series: { "5": { observations: { "0": [99] } } } }],
    };
    const obs = decodeSdmxJson(payload);
    expect(obs[0].key.X).toBe("5");  // index 5 has no entry → String(5)
  });

  it("casts observation value to number", () => {
    const payload = {
      dataSets: [{ series: { "0": { observations: { "0": ["42000"] } } } }],
    };
    const [obs] = decodeSdmxJson(payload);
    expect(typeof obs.value).toBe("number");
    expect(obs.value).toBe(42000);
  });
});

// ---- latestTime ----

describe("latestTime", () => {
  it("returns the latest time string", () => {
    const obs = [{ time: "2020" }, { time: "2022" }, { time: "2021" }];
    expect(latestTime(obs)).toBe("2022");
  });

  it("returns undefined for empty array", () => {
    expect(latestTime([])).toBeUndefined();
  });
});

// ---- extractPopulation ----

// Minimal mock with 3 ages (Y018-Y020) to keep the fixture small.
// Y018 is at dim-value index 1 (NOT 19), verifying the ageCodeToIdx lookup
// rather than the old age+1 arithmetic.
const MOCK_POP_RAW = {
  structure: {
    dimensions: {
      series: [
        { id: "INDICATOR",    values: [{ id: "PNMI_01" }, { id: "PNMI_02" }] },
        { id: "REGION",       values: [{ id: "UA00000000000000000" }] },
        { id: "AGE",          values: [{ id: "_T" }, { id: "Y018" }, { id: "Y019" }, { id: "Y020" }] },
        { id: "GENDER",       values: [{ id: "_T" }, { id: "FEMALE" }, { id: "MALE" }] },
        { id: "TERRAIN_TYPE", values: [{ id: "RUR" }, { id: "URB" }, { id: "_T" }] },
        { id: "FREQ",         values: [{ id: "A" }] },
      ],
      observation: [{ id: "TIME_PERIOD", values: [{ id: "2021" }, { id: "2022" }] }],
    },
  },
  dataSets: [{
    series: {
      // Dim order: INDICATOR:REGION:AGE:GENDER:TERRAIN_TYPE:FREQ
      // PNMI_02 idx=1, Ukraine idx=0, Y018 idx=1, MALE idx=2, _T terrain idx=2, A idx=0
      "1:0:1:2:2:0": { observations: { "1": [100000] } },
      "1:0:1:1:2:0": { observations: { "1": [90000]  } },
      "1:0:2:2:2:0": { observations: { "1": [95000]  } },
      "1:0:2:1:2:0": { observations: { "1": [85000]  } },
      "1:0:3:2:2:0": { observations: { "1": [98000]  } },
      "1:0:3:1:2:0": { observations: { "1": [88000]  } },
      // PNMI_01, _T age (idx 0), MALE/FEMALE
      "0:0:0:2:2:0": { observations: { "1": [500000] } },
      "0:0:0:1:2:0": { observations: { "1": [600000] } },
    },
  }],
};

describe("extractPopulation", () => {
  it("returns population totals from PNMI_01 when available", () => {
    const result = extractPopulation(MOCK_POP_RAW);
    expect(result).not.toBeNull();
    expect(result.population.man).toBe(500000);
    expect(result.population.woman).toBe(600000);
  });

  it("builds 11 age bands that sum to approximately 1.0", () => {
    const result = extractPopulation(MOCK_POP_RAW);
    expect(result.ageBands).toHaveLength(11);
    const sumMan   = result.ageBands.reduce((s, b) => s + b.man,   0);
    const sumWoman = result.ageBands.reduce((s, b) => s + b.woman, 0);
    expect(sumMan).toBeCloseTo(1, 3);
    expect(sumWoman).toBeCloseTo(1, 3);
  });

  it("uses ageCodeToIdx lookup — works when Y018 is NOT at index 19", () => {
    // In MOCK_POP_RAW, Y018 is at AGE index 1 (not 19).
    // If the old age+1 arithmetic were used, it would look up index 19 which doesn't exist.
    const result = extractPopulation(MOCK_POP_RAW);
    expect(result).not.toBeNull();
    // All three ages end up in band [18-24]
    expect(result.ageBands[0].man).toBeCloseTo(1, 3);
  });

  it("returns latest annual year", () => {
    const result = extractPopulation(MOCK_POP_RAW);
    expect(result._time).toBe("2022");
  });

  it("returns null and warns when a required dimension code is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = structuredClone(MOCK_POP_RAW);
    // Replace FEMALE code with something unrecognised
    bad.structure.dimensions.series[3].values[1].id = "F"; // was FEMALE
    const result = extractPopulation(bad);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("missing required dimension codes"));
    warnSpy.mockRestore();
  });

  it("returns null when dataSets is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractPopulation({ structure: MOCK_POP_RAW.structure });
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});

// ---- extractWages ----

const MOCK_WAGES_OBS = [
  { key: { PERIOD_OF_TIME: "MONTH", SEX: "MALE",   REGION: "UA00000000000000000", BREAKDOWN: "_T"     }, time: "2020", value: 12000 },
  { key: { PERIOD_OF_TIME: "MONTH", SEX: "FEMALE", REGION: "UA00000000000000000", BREAKDOWN: "_T"     }, time: "2020", value: 10000 },
  { key: { PERIOD_OF_TIME: "MONTH", SEX: "MALE",   REGION: "UA00000000000000000", BREAKDOWN: "MAG_EQ" }, time: "2020", value: 17000 },
  { key: { PERIOD_OF_TIME: "MONTH", SEX: "FEMALE", REGION: "UA00000000000000000", BREAKDOWN: "MAG_EQ" }, time: "2020", value: 13500 },
  { key: { PERIOD_OF_TIME: "HOUR",  SEX: "MALE",   REGION: "UA00000000000000000", BREAKDOWN: "_T"     }, time: "2020", value: 72   },
];

describe("extractWages", () => {
  it("returns logMean calibrated from average salary", () => {
    const sigma = 0.58;
    const result = extractWages(MOCK_WAGES_OBS, sigma);
    expect(result).not.toBeNull();
    expect(result.income.man.logMean).toBeCloseTo(Math.log(12000) - sigma * sigma / 2, 3);
    expect(result.income.woman.logMean).toBeCloseTo(Math.log(10000) - sigma * sigma / 2, 3);
  });

  it("computes higherEdBonus from master-degree vs total salary ratio", () => {
    const result = extractWages(MOCK_WAGES_OBS);
    const expected = (Math.log(17000 / 12000) + Math.log(13500 / 10000)) / 2;
    expect(result.income.man.higherEdBonus).toBeCloseTo(expected, 2);
  });

  it("uses sigma passed as parameter", () => {
    const result = extractWages(MOCK_WAGES_OBS, 0.5);
    expect(result.income.man.sigma).toBe(0.5);
  });

  it("returns correct latest time", () => {
    expect(extractWages(MOCK_WAGES_OBS)._time).toBe("2020");
  });

  it("returns null when no MONTH observations exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractWages([{ key: { PERIOD_OF_TIME: "HOUR" }, time: "2020", value: 50 }]);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no observations matched"));
    warnSpy.mockRestore();
  });
});

// ---- extractEducation ----

const MOCK_LF_OBS = [
  // Education: HIGHER
  { key: { INDICATOR: "EDUC_POPUL_PERC", BREAKDOWN_CATEGORY: "EDUC_LEVEL", BREAKDOWN: "HIGHER",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "MALE", AGE_GROUP: "Y15_24" }, time: "2021", value: 5.9 },
  { key: { INDICATOR: "EDUC_POPUL_PERC", BREAKDOWN_CATEGORY: "EDUC_LEVEL", BREAKDOWN: "HIGHER",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "FEMALE", AGE_GROUP: "Y15_24" }, time: "2021", value: 8.7 },
  { key: { INDICATOR: "EDUC_POPUL_PERC", BREAKDOWN_CATEGORY: "EDUC_LEVEL", BREAKDOWN: "HIGHER",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "MALE", AGE_GROUP: "Y25_64" }, time: "2021", value: 27.5 },
  { key: { INDICATOR: "EDUC_POPUL_PERC", BREAKDOWN_CATEGORY: "EDUC_LEVEL", BREAKDOWN: "HIGHER",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "FEMALE", AGE_GROUP: "Y25_64" }, time: "2021", value: 32.5 },
  // Employment
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "MALE", AGE_GROUP: "Y30_34" }, time: "2021", value: 83.7 },
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "FEMALE", AGE_GROUP: "Y40_49" }, time: "2021", value: 74.2 },
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "MALE", AGE_GROUP: "Y15_24" }, time: "2021", value: 27.1 },
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "FEMALE", AGE_GROUP: "Y15_24" }, time: "2021", value: 22.4 },
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "MALE", AGE_GROUP: "Y60_70" }, time: "2021", value: 15.4 },
  { key: { INDICATOR: "EMPL_POPUL_PERC", BREAKDOWN_CATEGORY: "_T", BREAKDOWN: "_T",
    REGION: "UA00000000000000000", TERRAIN_TYPE: "_T", UNITS_OF_MEASURE: "1010",
    GENDER: "FEMALE", AGE_GROUP: "Y60_70" }, time: "2021", value: 11.0 },
];

describe("extractEducation", () => {
  it("builds 3 education bands per sex", () => {
    const result = extractEducation(MOCK_LF_OBS);
    expect(result).not.toBeNull();
    expect(result.education.man).toHaveLength(3);
    expect(result.education.woman).toHaveLength(3);
  });

  it("converts % to proportion (value/100)", () => {
    const result = extractEducation(MOCK_LF_OBS);
    // Male Y25_64 = 27.5% → proportion ≈ 0.275
    expect(result.education.man[1].p).toBeCloseTo(0.275, 3);
  });

  it("applies 0.85 scaling to oldest band", () => {
    const result = extractEducation(MOCK_LF_OBS);
    expect(result.education.man[2].p).toBeCloseTo(0.275 * 0.85, 2);
  });

  it("returns null and warns when no EDUC_POPUL_PERC obs exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractEducation(MOCK_LF_OBS.filter((o) => o.key.INDICATOR !== "EDUC_POPUL_PERC"));
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no observations matched"));
    warnSpy.mockRestore();
  });
});

// ---- extractEmployment ----

describe("extractEmployment", () => {
  it("sets base rate from prime-age group (Y30_34 for men, Y40_49 for women)", () => {
    const result = extractEmployment(MOCK_LF_OBS);
    expect(result).not.toBeNull();
    expect(result.employment.man.base).toBeCloseTo(0.837, 3);
    expect(result.employment.woman.base).toBeCloseTo(0.742, 3);
  });

  it("derives youngPenalty from Y15_24 rate", () => {
    const result = extractEmployment(MOCK_LF_OBS);
    // men: (0.837 - 0.271) / 3 ≈ 0.189
    expect(result.employment.man.youngPenalty).toBeCloseTo((0.837 - 0.271) / 3, 2);
  });

  it("derives oldPenalty from Y60_70 rate", () => {
    const result = extractEmployment(MOCK_LF_OBS);
    // men: (0.837 - 0.154) / 7 ≈ 0.098
    expect(result.employment.man.oldPenalty).toBeCloseTo((0.837 - 0.154) / 7, 2);
  });

  it("returns null and warns when no EMPL_POPUL_PERC obs exist", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractEmployment(MOCK_LF_OBS.filter((o) => o.key.INDICATOR !== "EMPL_POPUL_PERC"));
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no observations matched"));
    warnSpy.mockRestore();
  });
});
