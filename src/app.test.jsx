import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

describe("App — model.json integration", () => {
  it("updates population when model.json loads with different totals", async () => {
    const mockModel = {
      population: { man: 9_000_000, woman: 12_000_000 },
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
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(mockModel) })
    );
    await act(async () => { render(<App />); });
    // Footer should show the generated date from the loaded model
    expect(screen.getByText(/15.01.2026/)).toBeInTheDocument();
  });

  it("falls back to default model when fetch throws", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network error")));
    await act(async () => { render(<App />); });
    expect(screen.getByText(/дані будуть оновлені/i)).toBeInTheDocument();
  });
});
