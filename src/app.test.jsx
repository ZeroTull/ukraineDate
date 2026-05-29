import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import App from "../app/dating_reality_check.jsx";

afterEach(() => vi.restoreAllMocks());

describe("App — smoke tests (default model)", () => {
  it("renders without crashing", () => {
    render(<App />);
    expect(screen.getByText(/Скільки таких насправді існує/i)).toBeInTheDocument();
  });

  it("shows a percentage result", () => {
    render(<App />);
    expect(document.querySelector(".pct")).toBeTruthy();
  });

  it("toggles gender", () => {
    render(<App />);
    const btn = screen.getByText(/Шукаю жінку/i);
    fireEvent.click(btn);
    expect(btn.className).toContain("on");
  });

  it("shows the funnel section", () => {
    render(<App />);
    expect(screen.getByText(/Куди зникають кандидати/i)).toBeInTheDocument();
  });

  it("shows the sources details section", () => {
    render(<App />);
    expect(screen.getByText(/Звідки дані/i)).toBeInTheDocument();
  });

  it("shows fallback footer text when model.json is absent", () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false }));
    render(<App />);
    expect(screen.getByText(/дані будуть оновлені/i)).toBeInTheDocument();
  });
});

// A minimal but complete valid model for testing.
const SMALL_MODEL = {
  population: { man: 1_000_000, woman: 2_000_000 },
  ageBands: [{ from: 18, to: 78, man: 1.0, woman: 1.0 }],
  education: {
    man:   [{ from: 18, to: 78, p: 0.5 }],
    woman: [{ from: 18, to: 78, p: 0.5 }],
  },
  income: {
    man:   { logMean: 9.95, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
    woman: { logMean: 9.77, sigma: 0.58, higherEdBonus: 0.42, agePeak: 41, ageCurvature: 0.00065 },
  },
  employment: {
    man:   { base: 0.66, youngPenalty: 0.04, oldPenalty: 0.045 },
    woman: { base: 0.58, youngPenalty: 0.04, oldPenalty: 0.045 },
  },
  behavioral: {
    height:   { man: { mean: 176, sd: 7 }, woman: { mean: 165.5, sd: 6.2 } },
    smoking:  { man: 0.5, woman: 0.17, higherEdMultiplier: 0.72 },
    teetotal: { man: 0.22, woman: 0.42 },
    kids:     { midAge: 30, steepness: 0.28, manFactor: 0.92, womanFactor: 0.97 },
    ownsHome: { base: 0.18, ageSlope: 0.011, incomeBonus: 0.08 },
    hasCar:   { incomeMid: 25000, incomeScale: 22000, manFactor: 1.05, womanFactor: 0.9 },
    serving:  { manPeakAge: 37, manPeakProb: 0.14, manSpread: 420, womanProb: 0.02 },
  },
  meta: { generatedAt: "2026-01-15T00:00:00.000Z" },
};

function parseAbsoluteCount(container) {
  const el = container.querySelector(".abs");
  if (!el) return NaN;
  // "≈ 1 234 567 реальних людей" — strip non-numeric except thin-space separators
  return parseInt(el.textContent.replace(/[^\d]/g, ""), 10);
}

describe("App — model.json integration", () => {
  it("absolute count reflects loaded model population (1M vs 11.5M default)", async () => {
    // requestAnimationFrame in jsdom never advances time, freezing useAnimated.
    // Complete the animation instantly by advancing the timestamp past the duration.
    vi.stubGlobal("requestAnimationFrame", (cb) => { cb(performance.now() + 1000); return 0; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    // Render 1: fetch fails → uses DEFAULT_MODEL (11.5M men)
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false }));
    const { container: c1 } = render(<App />);
    await act(async () => {});
    const countDefault = parseAbsoluteCount(c1);
    cleanup();

    // Render 2: fetch succeeds → uses SMALL_MODEL (1M men)
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(SMALL_MODEL) })
    );
    const { container: c2 } = render(<App />);
    await act(async () => {});
    const countSmall = parseAbsoluteCount(c2);

    // SMALL_MODEL has 1M men vs 11.5M default → absolute count should be ~11.5x smaller
    expect(countSmall).toBeGreaterThan(0);
    expect(countDefault).toBeGreaterThan(countSmall);
  });

  it("footer shows ETL generation date after model loads", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(SMALL_MODEL) })
    );
    await act(async () => { render(<App />); });
    expect(screen.getByText(/15.01.2026/)).toBeInTheDocument();
  });

  it("rejects model missing required fields — keeps default", async () => {
    const badModel = { population: { man: 1, woman: 1 } }; // missing ageBands etc.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(badModel) })
    );
    const { container } = render(<App />);
    await act(async () => {});
    // Footer still shows fallback text (default model in use)
    expect(screen.getByText(/дані будуть оновлені/i)).toBeInTheDocument();
    // App still renders results
    expect(container.querySelector(".pct")).toBeTruthy();
  });

  it("app remains fully functional when fetch fails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network error")));
    const { container } = render(<App />);
    await act(async () => {});
    expect(container.querySelector(".pct")).toBeTruthy();
    expect(parseAbsoluteCount(container)).toBeGreaterThan(0);
    expect(screen.getByText(/дані будуть оновлені/i)).toBeInTheDocument();
  });
});
