# Демографічний калькулятор — як зібрати

A "dating-market reality check": set filters (gender, age, height, income,
education, lifestyle) and see what share of Ukraine's population matches.
Unlike similar tools, it does **not** multiply probabilities — it filters a
synthetic population with the correlations built in.

## Project layout

```
app/
  dating_reality_check.jsx   the React single-page app (the UI + model)
  model.json                 the data bundle (produced by etl.mjs)
etl.mjs                      pulls official data from stat.gov.ua
README.md
```

## How the data flows

```
stat.gov.ua  ──SDMX API──►  etl.mjs  ──►  model.json  ──►  React app
(Derzhstat)                  (one-off ETL)               (synthetic population
WHO STEPS 2019 ──(manual)──►                              + live filtering)
```

The app never calls the API directly. `etl.mjs` runs once (or on a schedule),
turns official statistics into a compact `model.json`, and the app ships that
file as a static asset. No backend, no database.

## Step 1 — set up the ETL

```bash
npm install fast-xml-parser      # Node 18+ required
node etl.mjs list                # list every Derzhstat dataflow
node etl.mjs search wage         # filter the list by keyword
node etl.mjs inspect <DF_ID>     # show a dataflow's dimensions + codes
```

Useful search words: `population`, `wage` / `earnings`, `education`,
`labour force`.

## Step 2 — wire in the real dataflows

Open `etl.mjs`, find the `DATAFLOWS` config, and replace each `TODO_*` id
with the real one from `list`. Use `inspect` to confirm the dimension ids
and the codelist codes (e.g. which code means "male", which means "higher
education"), and update `dim` / `code` accordingly.

```bash
node etl.mjs build               # writes model.json
```

Any block still left as `TODO_*` keeps a placeholder value, so `build`
always produces a valid, app-ready file. The `meta.blocks` field in the
output tells you which blocks are `live` vs `placeholder`.

## What is live vs. manual

| Block        | Source                                  | Filled by        |
|--------------|-----------------------------------------|------------------|
| population   | Derzhstat (SDMX)                        | ETL              |
| age bands    | Derzhstat (SDMX)                        | ETL              |
| income       | Derzhstat — average wage                | ETL (calibrated) |
| education    | Derzhstat / Labour Force Survey         | ETL (scaffold)   |
| height       | WHO STEPS 2019                          | manual constant  |
| smoking      | WHO STEPS 2019 (men 50.3%, women 16.7%) | manual constant  |
| alcohol      | WHO STEPS 2019                          | manual constant  |
| kids / home / car | household surveys                  | manual estimate  |
| "at the front"    | none — military data is classified | modelled guess   |

Behavioural variables aren't in the Derzhstat SDMX API, so they live in the
`MANUAL` block of `etl.mjs` with their sources cited. Update them by hand
from the linked reports.

## Caveats baked into the model

- Ukraine's last census was 2001; population figures are estimates carried
  forward. Wartime displacement adds roughly ±15–20% uncertainty.
- The app shows a **range**, not a single number, for this reason.
- "Not at the front" is a modelled estimate — official figures don't exist.

## Step 3 — run the app

`model.json` is loaded by the React app at runtime. In the Vite project drop
it in `public/` (or `src/`); the app falls back to built-in defaults if the
file is missing, so it also runs standalone.
