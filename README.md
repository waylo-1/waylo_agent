# Waylo — Agent Backend

**Waylo is an AI guide that points a glowing red dot at exactly what to tap next, inside any app, on Android and macOS — so anyone can do things on their phone by doing them themselves.**

This repository is Waylo's **agentic backend**: a [GenKit](https://genkit.dev) agent, powered by **Gemini 3.5**, deployed on **Google Cloud Run**. It decides one on-screen step at a time from the live screen, verifies what happened, and recovers when the screen isn't what it expected.

Built for the **All Things Agentic** hackathon.

---

## What makes it an agent

The old design wrote a whole plan up front and followed it blindly. This backend runs a live loop instead:

**perceive → reason → act → verify → adapt**

After each user action, the Android app sends the updated screen to `POST /agent/next`, and the agent returns the **single** next action — or marks the goal `done`, or `recover`s from a surprise (a pop-up, the wrong app, an error).

```mermaid
flowchart TD
    A["Android app<br/>reads screen · draws red box"] -->|"goal + live screen"| B
    subgraph GCP["Google Cloud Run"]
      B["Node / Express<br/>+ GenKit agent"]
    end
    B <-->|"tool-calling loop"| C["Gemini 3.5<br/>(gemini-3.5-flash)"]
    B -->|"semantic plan cache"| D[("PostgreSQL<br/>+ pgvector")]
    B -.->|"next single action / done / recover"| A
```

## Tech (hackathon requirements)

| Requirement | How this repo meets it |
| --- | --- |
| **Gemini 3.5 or newer** | `gemini-3.5-flash`, called on every agent turn |
| **Google Agent Framework** | **GenKit** — `services/agent.js` defines the `nextStep` flow with structured output |
| **Google Cloud service** | Deployed on **Cloud Run** (see below) |

## The agent flow

`services/agent.js` is the brain. It defines a GenKit flow, `nextStep`, whose **structured output** forces Gemini to return exactly the JSON the Android client parses:

```json
{
  "status": "continue | done | recover",
  "reasoning": "one short sentence",
  "action": {
    "instruction": "spoken step, e.g. \"Tap Notifications in the middle of the screen.\"",
    "findDescription": "rich text for on-device element search",
    "elementType": "LIST_ITEM",
    "screenRegion": "center",
    "visualDescription": "...",
    "alternateLabels": ["..."],
    "fallbackHint": "..."
  }
}
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness check |
| `POST /agent/next` | **The agent.** Body: `{ goal, appName?, appPackage?, screen?, history? }` → returns the decision above |
| `POST /plan` | Legacy one-shot planner (kept for compatibility) |
| `POST /vision`, `/vision-fallback` | Vision grounding helpers |

## Run it locally

```bash
npm install
cp .env.example .env      # then fill in the values
npm start                 # boots on PORT (default 3000)
```

Smoke-test the agent:

```bash
curl -s -X POST http://localhost:3000/agent/next \
  -H 'Content-Type: application/json' \
  -d '{"goal":"turn off notifications","appName":"Settings","screen":"Settings home. Items: Apps, Notifications, Battery, Sound, Display.","history":[{"instruction":"Open Settings","outcome":"Settings opened"}]}'
```

## Deploy to Google Cloud Run

Prerequisites: a GCP project with billing, and the `gcloud` CLI (`gcloud init`).

```bash
# 1. enable the APIs (once)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. put your secrets in a local env file (NOT committed), e.g. deploy-env.yaml:
#    AI_PROVIDER: "gemini"
#    GEMINI_API_KEY: "..."
#    GEMINI_TEXT_MODEL: "gemini-3.5-flash"
#    GEMINI_VISION_MODEL: "gemini-3.5-flash"
#    DATABASE_URL: "postgres://USER:PASSWORD@HOST:5432/DBNAME"

# 3. deploy (builds the Dockerfile on Cloud Build, no local Docker needed)
gcloud run deploy waylo-backend \
  --source . --region asia-south1 --allow-unauthenticated \
  --env-vars-file deploy-env.yaml --memory 512Mi
```

Cloud Run returns a public `https://…run.app` URL. It injects `PORT`, which `index.js` already reads.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | `gemini` (this repo runs on Gemini via GenKit) |
| `GEMINI_API_KEY` | Gemini API key from [AI Studio](https://aistudio.google.com/app/apikey) |
| `GEMINI_TEXT_MODEL` / `GEMINI_VISION_MODEL` | `gemini-3.5-flash` |
| `DATABASE_URL` | PostgreSQL (pgvector) connection string for the plan cache |
| `PORT` | Server port (Cloud Run sets this automatically) |

## Repo layout

```
index.js            Express server + routes (incl. POST /agent/next)
services/agent.js   The GenKit agent — the nextStep flow (Gemini 3.5, structured output)
services/llm.js     Provider abstraction (gemini | bedrock)
services/           promptSpecs, providers
routes/             vision, vision-fallback, yolo-detect, failure
db.js               PostgreSQL pool
semanticPlanCache*  Embedding-based plan reuse
Dockerfile          Cloud Run container
```

The Android client lives in a separate repository.

## License

MIT — see [LICENSE](LICENSE).
