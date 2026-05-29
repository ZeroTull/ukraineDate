import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* =====================================================================
   ДЕМОГРАФІЧНИЙ КАЛЬКУЛЯТОР — прототип
   Метод: синтетична популяція (~40 000 осіб) з вбудованими кореляціями.
   Фільтрація = підрахунок, а не перемноження ймовірностей.
   УВАГА: усі числові параметри нижче — ОРІЄНТОВНІ ПЛЕЙСХОЛДЕРИ.
   Реальні значення підставляються з Держстату (SDMX), ОРС та WHO STEPS 2019.
   ===================================================================== */

const N = 40_000; // розмір синтетичної вибірки на стать

// Built-in defaults — used until model.json loads (or if it's absent).
// Values mirror public/model.json placeholders so the app is always runnable.
const DEFAULT_MODEL = {
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
  behavioral: {
    height:   { man: { mean: 176.0, sd: 7.0 }, woman: { mean: 165.5, sd: 6.2 } },
    smoking:  { man: 0.503, woman: 0.167, higherEdMultiplier: 0.72 },
    teetotal: { man: 0.22, woman: 0.42 },
    kids:     { midAge: 30, steepness: 0.28, manFactor: 0.92, womanFactor: 0.97 },
    ownsHome: { base: 0.18, ageSlope: 0.011, incomeBonus: 0.08 },
    hasCar:   { incomeMid: 25000, incomeScale: 22000, manFactor: 1.05, womanFactor: 0.9 },
    serving:  { manPeakAge: 37, manPeakProb: 0.14, manSpread: 420, womanProb: 0.02 },
  },
};

// --- seeded RNG (детерміновано => стабільні результати) ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormal(rng) {
  return () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logistic = (x) => 1 / (1 + Math.exp(-x));

function sampleAge(rng, ageBands, gender) {
  let r = rng(), acc = 0;
  for (const b of ageBands) {
    acc += b[gender];
    if (r <= acc) return b.from + Math.floor(rng() * (b.to - b.from + 1));
  }
  return 45;
}

function makePerson(gender, rng, norm, model) {
  const man = gender === "man";
  const { behavioral: beh, education: edu, income: inc, employment: emp } = model;

  const age = sampleAge(rng, model.ageBands, gender);

  const h = beh.height?.[gender] ?? DEFAULT_MODEL.behavioral.height[gender];
  const height = clamp(h.mean + (40 - age) * 0.045 + norm() * h.sd, 140, 210);

  const eduArr = edu[gender] ?? DEFAULT_MODEL.education[gender];
  const eduBand = eduArr.find((b) => age >= b.from && age <= b.to) ?? eduArr.at(-1);
  const higherEd = rng() < clamp(eduBand?.p ?? 0.5, 0.1, 0.78);

  const e = emp[gender];
  const pEmp = e.base - Math.max(0, age - 58) * e.oldPenalty - Math.max(0, 23 - age) * e.youngPenalty;
  const employed = rng() < clamp(pEmp, 0.05, 0.92);

  let income = rng() * 3000;
  if (employed) {
    const i = inc[gender];
    let lm = i.logMean + (higherEd ? i.higherEdBonus : 0) - i.ageCurvature * Math.pow(age - i.agePeak, 2);
    income = Math.exp(lm + norm() * i.sigma);
  }

  const smoker   = rng() < beh.smoking[gender] * (higherEd ? beh.smoking.higherEdMultiplier : 1);
  const teetotal = rng() < beh.teetotal[gender];
  const hasKids  = rng() < logistic((age - beh.kids.midAge) * beh.kids.steepness) * beh.kids[man ? "manFactor" : "womanFactor"];
  const ownsHome = rng() < clamp(beh.ownsHome.base + (age - 22) * beh.ownsHome.ageSlope + (income > 30000 ? beh.ownsHome.incomeBonus : 0), 0.05, 0.8);
  const hasCar   = rng() < clamp(logistic((income - beh.hasCar.incomeMid) / beh.hasCar.incomeScale) * beh.hasCar[man ? "manFactor" : "womanFactor"], 0.04, 0.95);

  const sv = beh.serving;
  const pServe = man && age >= 20 && age <= 55
    ? sv.manPeakProb * Math.exp(-Math.pow(age - sv.manPeakAge, 2) / sv.manSpread)
    : (!man && age >= 20 && age <= 50 ? sv.womanProb : 0);
  const serving = rng() < pServe;

  return { age, height, higherEd, income, smoker, teetotal, hasKids, ownsHome, hasCar, serving };
}

function generatePopulation(gender, model) {
  const rng = mulberry32(gender === "man" ? 1337 : 8842);
  const norm = makeNormal(rng);
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = makePerson(gender, rng, norm, model);
  return arr;
}

function isValidModel(m) {
  if (!m || typeof m !== "object") return false;
  if (!["population", "ageBands", "education", "income", "employment", "behavioral"].every((k) => k in m)) return false;
  if (!Array.isArray(m.ageBands) || m.ageBands.length === 0) return false;
  if (!m.ageBands.every((b) => "from" in b && "to" in b && "man" in b && "woman" in b)) return false;
  if (!["man", "woman"].every((g) => Array.isArray(m.education?.[g]) && m.education[g].length > 0)) return false;
  if (!["man", "woman"].every((g) => m.income?.[g]?.logMean != null)) return false;
  if (!["man", "woman"].every((g) => m.employment?.[g]?.base != null)) return false;
  const bKeys = ["height", "smoking", "teetotal", "kids", "ownsHome", "hasCar", "serving"];
  if (!bKeys.every((k) => k in (m.behavioral ?? {}))) return false;
  return true;
}

// --- форматери ---
const fmtInt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u202F");
function roundSig(n, s = 2) {
  if (n <= 0) return 0;
  const p = s - Math.ceil(Math.log10(n));
  const m = Math.pow(10, p);
  return Math.round(n * m) / m;
}
function fmtPct(p) {
  if (p <= 0) return "0";
  if (p < 0.01) return "<0.01";
  if (p < 1) return p.toFixed(2);
  if (p < 10) return p.toFixed(1);
  return Math.round(p).toString();
}

// --- анімований числовий перехід ---
function useAnimated(target, dur = 450) {
  const [val, setVal] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now(), f = from.current;
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(f + (target - f) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return val;
}

// --- слайдери (pointer events, без залежностей) ---
function valFromX(clientX, rect, min, max, step) {
  let r = clamp((clientX - rect.left) / rect.width, 0, 1);
  return clamp(Math.round((min + r * (max - min)) / step) * step, min, max);
}
function SingleSlider({ min, max, step, value, onChange }) {
  const ref = useRef(null), drag = useRef(false);
  const upd = useCallback((x) => onChange(valFromX(x, ref.current.getBoundingClientRect(), min, max, step)),
    [min, max, step, onChange]);
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider" ref={ref}
      onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); upd(e.clientX); }}
      onPointerMove={(e) => drag.current && upd(e.clientX)}
      onPointerUp={() => (drag.current = false)}
      onPointerCancel={() => (drag.current = false)}>
      <div className="s-track" /><div className="s-fill" style={{ width: pct + "%" }} />
      <div className="s-thumb" style={{ left: pct + "%" }} />
    </div>
  );
}
function DualSlider({ min, max, step, value, onChange }) {
  const ref = useRef(null), active = useRef(null);
  const [lo, hi] = value;
  const upd = (x) => {
    const v = valFromX(x, ref.current.getBoundingClientRect(), min, max, step);
    if (active.current === "lo") onChange([Math.min(v, hi), hi]);
    else onChange([lo, Math.max(v, lo)]);
  };
  const loP = ((lo - min) / (max - min)) * 100, hiP = ((hi - min) / (max - min)) * 100;
  return (
    <div className="slider" ref={ref}
      onPointerDown={(e) => {
        const v = valFromX(e.clientX, ref.current.getBoundingClientRect(), min, max, step);
        active.current = Math.abs(v - lo) <= Math.abs(v - hi) ? "lo" : "hi";
        e.currentTarget.setPointerCapture?.(e.pointerId); upd(e.clientX);
      }}
      onPointerMove={(e) => active.current && upd(e.clientX)}
      onPointerUp={() => (active.current = null)}
      onPointerCancel={() => (active.current = null)}>
      <div className="s-track" />
      <div className="s-fill" style={{ left: loP + "%", width: hiP - loP + "%" }} />
      <div className="s-thumb" style={{ left: loP + "%" }} />
      <div className="s-thumb" style={{ left: hiP + "%" }} />
    </div>
  );
}

const VERDICTS = [
  [12, "Цілком собі реалістично", "🙂"],
  [5, "Вибагливо, але такі є", "🙂"],
  [1.5, "Доволі вузьке коло", "🤔"],
  [0.3, "Полювання на рідкість", "🔍"],
  [0.03, "Майже однороги", "🦄"],
  [0, "Стоп. Це практично нереально", "🧐"],
];

export default function App() {
  const [gender, setGender] = useState("man");
  const [age, setAge] = useState([29, 42]);
  const [height, setHeight] = useState(178);
  const [incomeK, setIncomeK] = useState(30);
  const [edu, setEdu] = useState("any");
  const [chk, setChk] = useState({
    nonSmoker: true, nonDrinker: false, noKids: false,
    ownsHome: false, hasCar: true, notServing: false,
  });
  const [model, setModel] = useState(DEFAULT_MODEL);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}model.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => { if (isValidModel(data)) setModel(data); });
  }, []);

  const population = useMemo(() => generatePopulation(gender, model), [gender, model]);

  // побудова "лійки": послідовні зрізи однієї популяції => кореляції враховано
  const { rows, fraction, matches } = useMemo(() => {
    const minIncome = incomeK * 1000;
    const stages = [{ label: `Вік ${age[0]}\u2013${age[1]} р.`, t: (p) => p.age >= age[0] && p.age <= age[1] }];
    if (height > 150) stages.push({ label: `Зріст ${height}+ см`, t: (p) => p.height >= height });
    if (incomeK > 0) stages.push({ label: `Дохід ${incomeK}+ тис/міс`, t: (p) => p.income >= minIncome });
    if (edu === "higher") stages.push({ label: "Вища освіта", t: (p) => p.higherEd });
    if (chk.nonSmoker) stages.push({ label: "Не курить", t: (p) => !p.smoker });
    if (chk.nonDrinker) stages.push({ label: "Не вживає алкоголь", t: (p) => p.teetotal });
    if (chk.noKids) stages.push({ label: "Без дітей", t: (p) => !p.hasKids });
    if (chk.ownsHome) stages.push({ label: "Власне житло", t: (p) => p.ownsHome });
    if (chk.hasCar) stages.push({ label: "Є авто", t: (p) => p.hasCar });
    if (chk.notServing) stages.push({ label: "Не на фронті *", t: (p) => !p.serving });

    let pool = population;
    const rows = [];
    for (const s of stages) {
      pool = pool.filter(s.t);
      rows.push({ label: s.label, pct: (pool.length / population.length) * 100 });
    }
    return { rows, fraction: pool.length / population.length, matches: pool.length };
  }, [population, age, height, incomeK, edu, chk]);

  const pct = fraction * 100;
  const absMid = roundSig(fraction * model.population[gender], 2);
  const relUnc = Math.sqrt(0.18 * 0.18 + (matches > 0 ? 1 / matches : 1));
  const absLow = roundSig(absMid * (1 - relUnc), 2);
  const absHigh = roundSig(absMid * (1 + relUnc), 2);

  const aPct = useAnimated(pct);
  const aAbs = useAnimated(absMid);
  const verdict = VERDICTS.find(([thr]) => pct >= thr);
  const noun = gender === "man" ? "чоловіків України" : "жінок України";

  const toggleChk = (k) => setChk((s) => ({ ...s, [k]: !s[k] }));
  const CHECKS = [
    ["nonSmoker", "Не курить"], ["nonDrinker", "Не п'є"],
    ["noKids", "Без дітей"], ["ownsHome", "Своє житло"],
    ["hasCar", "Є авто"], ["notServing", "Не на фронті *"],
  ];

  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="grain" />
      <main className="wrap">
        <header className="head anim" style={{ animationDelay: "0s" }}>
          <div className="kicker">Демографічний калькулятор · прототип</div>
          <h1>Скільки таких насправді існує?</h1>
          <p className="sub">Чесна математика замість перемноження ймовірностей. Це модельна оцінка, а не перепис.</p>
        </header>

        <div className="toggle anim" style={{ animationDelay: ".05s" }}>
          <button className={gender === "man" ? "on" : ""} onClick={() => setGender("man")}>Шукаю чоловіка</button>
          <button className={gender === "woman" ? "on" : ""} onClick={() => setGender("woman")}>Шукаю жінку</button>
        </div>

        <div className="grid2">
          <div className="card anim" style={{ animationDelay: ".1s" }}>
            <div className="card-title">Вік</div>
            <div className="bigval">{age[0]}–{age[1]}<small>років</small></div>
            <DualSlider min={18} max={70} step={1} value={age} onChange={setAge} />
          </div>
          <div className="card anim" style={{ animationDelay: ".15s" }}>
            <div className="card-title">Зріст від</div>
            <div className="bigval">{height}<small>см</small></div>
            <SingleSlider min={150} max={205} step={1} value={height} onChange={setHeight} />
          </div>
          <div className="card anim" style={{ animationDelay: ".2s" }}>
            <div className="card-title">Дохід від</div>
            <div className="bigval">{incomeK}<small>тис грн/міс</small></div>
            <SingleSlider min={0} max={120} step={1} value={incomeK} onChange={setIncomeK} />
          </div>
          <div className="card anim" style={{ animationDelay: ".25s" }}>
            <div className="card-title">Освіта</div>
            <div className="opt" onClick={() => setEdu("higher")}>
              <span className={"radio" + (edu === "higher" ? " on" : "")} />Вища освіта
            </div>
            <div className="opt" onClick={() => setEdu("any")}>
              <span className={"radio" + (edu === "any" ? " on" : "")} />Не важливо
            </div>
          </div>
        </div>

        <div className="card anim" style={{ animationDelay: ".3s" }}>
          <div className="card-title">А ще має бути…</div>
          <div className="checkgrid">
            {CHECKS.map(([k, label]) => (
              <div key={k} className="check" onClick={() => toggleChk(k)}>
                <span className={"box" + (chk[k] ? " on" : "")}>{chk[k] ? "✓" : ""}</span>{label}
              </div>
            ))}
          </div>
        </div>

        <div className="result anim" style={{ animationDelay: ".35s" }}>
          <div className="tag">Ймовірна оцінка</div>
          <div className="pct">{fmtPct(aPct)}<span className="sym">%</span></div>
          <div className="result-sub">{noun} відповідають твоїм критеріям</div>
          <div className="abs">≈ {fmtInt(aAbs)} реальних людей</div>
          <div className="range">правдоподібний діапазон: {fmtInt(absLow)} – {fmtInt(absHigh)}</div>
          <div className="verdict">{verdict[2]} {verdict[1]}</div>
        </div>

        <div className="card anim" style={{ animationDelay: ".4s" }}>
          <div className="card-title">Куди зникають кандидати</div>
          {rows.map((r, i) => (
            <div className="funnel-row" key={i}>
              <div className="fl"><span>{r.label}</span>
                <span className="pctnum">{fmtPct(r.pct)}%</span></div>
              <div className="fbar"><div className="ffill" style={{ width: Math.max(r.pct, 0.7) + "%" }} /></div>
            </div>
          ))}
          <div className="funnel-note">Кожен рядок — це % від усіх дорослих обраної статі, що проходять цей
            фільтр <i>разом</i> з попередніми. Бачиш, де коло звужується найрізкіше.</div>
        </div>

        <details className="src anim" style={{ animationDelay: ".45s" }}>
          <summary>Звідки дані та чому це лише оцінка</summary>
          <ul>
            <li>Метод: синтетична популяція ~40 000 осіб із врахуванням кореляцій (освіта↔дохід, вік↔діти, дохід↔авто), а не перемноження ймовірностей — саме тому числа реалістичніші за звичайні «калькулятори мрії».</li>
            <li>Зріст, куріння, алкоголь — обстеження WHO STEPS (Україна, 2019).</li>
            <li>Дохід та освіта — Держстат (SDMX API) та обстеження робочої сили.</li>
            <li>Базова чисельність населення — груба оцінка для підконтрольної території; через війну точної цифри не існує (±15–20%).</li>
            <li>* «Не на фронті» — приблизна оцінка: офіційна військова статистика закрита.</li>
            <li>Усі числові параметри цього прототипу — орієнтовні плейсхолдери. Фінальні значення підставимо з реальних наборів даних.</li>
          </ul>
        </details>

        <footer className="foot">
          Прототип
          {model.meta?.generatedAt
            ? ` · дані оновлено ${new Date(model.meta.generatedAt).toLocaleDateString("uk-UA")}`
            : " · дані будуть оновлені офіційними джерелами"}
        </footer>
      </main>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=Unbounded:wght@500;700;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --card:#FFFCF7;--line:#EADCC8;--ink:#2B2520;--muted:#A2917C;
  --accent:#DD5A2A;--accent-soft:#FBE6D8;
}
.app{font-family:'Onest',-apple-system,system-ui,sans-serif;min-height:100vh;color:var(--ink);
  background:radial-gradient(120% 80% at 50% 0%,#F7EFE4,#EFDFCB);
  -webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden;}
.grain{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.3;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.45'/></svg>");}
.wrap{position:relative;z-index:1;max-width:470px;margin:0 auto;padding:30px 17px 50px;}
.head{margin-bottom:18px;}
.kicker{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:700;}
.head h1{font-family:'Unbounded',sans-serif;font-weight:700;font-size:26px;line-height:1.14;margin:9px 0 8px;letter-spacing:-.01em;}
.sub{font-size:13px;color:var(--muted);line-height:1.55;}
.toggle{display:flex;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:6px;margin-bottom:13px;}
.toggle button{flex:1;border:0;background:transparent;font-family:inherit;font-size:13.5px;font-weight:600;
  color:var(--muted);padding:12px 6px;border-radius:11px;cursor:pointer;transition:.18s;}
.toggle button.on{background:var(--accent);color:#fff;box-shadow:0 7px 16px -8px var(--accent);}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:11px;}
@media(max-width:355px){.grid2{grid-template-columns:1fr;}}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:15px 16px;
  box-shadow:0 10px 26px -20px rgba(70,45,20,.7);}
.card-title{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:7px;}
.bigval{font-family:'Unbounded',sans-serif;font-weight:700;font-size:22px;letter-spacing:-.01em;}
.bigval small{font-size:11px;font-weight:500;color:var(--muted);font-family:'Onest';margin-left:4px;}
.slider{position:relative;height:26px;display:flex;align-items:center;cursor:pointer;
  touch-action:none;user-select:none;margin-top:11px;}
.s-track{position:absolute;left:0;right:0;height:6px;background:#EFE3D2;border-radius:6px;}
.s-fill{position:absolute;height:6px;background:var(--accent);border-radius:6px;}
.s-thumb{position:absolute;width:21px;height:21px;background:#fff;border:3px solid var(--accent);
  border-radius:50%;transform:translateX(-50%);box-shadow:0 3px 9px -2px rgba(70,40,20,.5);pointer-events:none;}
.opt{display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;font-size:14px;font-weight:500;}
.radio{width:18px;height:18px;border-radius:50%;border:2px solid var(--line);flex:none;
  display:flex;align-items:center;justify-content:center;transition:.15s;}
.radio.on{border-color:var(--accent);}
.radio.on::after{content:'';width:9px;height:9px;border-radius:50%;background:var(--accent);}
.checkgrid{display:grid;grid-template-columns:1fr 1fr;gap:11px 14px;}
.check{display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13.5px;font-weight:500;}
.box{width:20px;height:20px;border-radius:7px;border:2px solid var(--line);flex:none;
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;transition:.15s;}
.box.on{background:var(--accent);border-color:var(--accent);}
.result{margin:15px 0 11px;background:linear-gradient(170deg,#FFF7EF,#F8E4D2);
  border:1px solid #E8CFB6;border-radius:24px;padding:22px 20px;text-align:center;
  box-shadow:0 18px 38px -24px rgba(120,60,20,.7);}
.result .tag{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:700;}
.pct{font-family:'Unbounded',sans-serif;font-weight:900;font-size:clamp(58px,17vw,102px);
  line-height:.92;letter-spacing:-.04em;margin-top:6px;}
.pct .sym{color:var(--accent);font-size:.46em;margin-left:2px;}
.result-sub{font-size:13px;color:#6c5d4d;margin-top:9px;font-weight:500;}
.abs{font-family:'Unbounded',sans-serif;font-weight:700;font-size:18px;margin-top:13px;}
.range{font-size:11.5px;color:var(--muted);margin-top:4px;}
.verdict{display:inline-block;margin-top:13px;background:var(--accent-soft);color:var(--accent);
  font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:20px;}
.funnel-row{margin-top:11px;}
.fl{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px;}
.fl .pctnum{font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent);}
.fbar{height:9px;background:#EFE3D2;border-radius:6px;overflow:hidden;}
.ffill{height:100%;background:linear-gradient(90deg,#E9824B,var(--accent));border-radius:6px;
  transition:width .4s cubic-bezier(.4,0,.2,1);}
.funnel-note{font-size:11px;color:var(--muted);line-height:1.5;margin-top:13px;}
.src{margin-top:13px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:2px 16px;}
.src summary{cursor:pointer;font-size:12.5px;font-weight:600;padding:13px 0;list-style:none;}
.src summary::-webkit-details-marker{display:none;}
.src summary::before{content:'+';margin-right:9px;color:var(--accent);font-weight:700;font-size:15px;}
.src[open] summary::before{content:'–';}
.src ul{padding:0 0 14px;list-style:none;display:grid;gap:9px;}
.src li{font-size:11.5px;color:var(--muted);line-height:1.55;padding-left:15px;position:relative;}
.src li::before{content:'';position:absolute;left:0;top:6px;width:5px;height:5px;border-radius:50%;background:var(--accent);}
.foot{text-align:center;font-size:10.5px;color:var(--muted);margin-top:22px;}
@keyframes rise{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;}}
.anim{animation:rise .5s both;}
`;
