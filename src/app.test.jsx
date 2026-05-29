import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "../app/dating_reality_check.jsx";

describe("App — smoke tests", () => {
  it("renders without crashing", () => {
    render(<App />);
    expect(screen.getByText(/Скільки таких насправді існує/i)).toBeInTheDocument();
  });

  it("shows a percentage result", () => {
    render(<App />);
    // The result section always shows a % symbol
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
});
