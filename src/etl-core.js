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
