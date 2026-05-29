import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheRead, cacheWrite, decodeSdmxJson } from "./etl-core.js";

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
