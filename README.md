<div align="center">

# 🔴 Waylo Agent — the Collaborative Partner brain

**An agentic backend that guides a person through any task on their phone/computer — one step at a time, asking when it's unsure, and remembering what they told it across sessions.**

[![Gemini 3.5](https://img.shields.io/badge/Gemini-3.5%20Flash-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev)
[![Genkit](https://img.shields.io/badge/Framework-Genkit-FF6F00)](https://genkit.dev)
[![Cloud Run](https://img.shields.io/badge/Google%20Cloud-Cloud%20Run-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)
[![Firestore](https://img.shields.io/badge/Google%20Cloud-Firestore-FFA000?logo=firebase&logoColor=white)](https://firebase.google.com/docs/firestore)

**Built for the All Things Agentic Hackathon · Track: The Collaborative Partner**

**Live:** `https://waylo-agent-506434766076.asia-south1.run.app`

</div>

![Waylo Agent — architecture](docs/architecture.png)

Waylo Agent is the next-generation brain for [Waylo](https://github.com/waylo-1) — the app that puts a talking red dot on the exact thing to tap next, teaching elderly and first-time users to use any app. Instead of writing the whole plan up front and following it blindly, this agent decides **one action at a time**, grounded in the *current* screen and the conversation so far — and it **collaborates**: it asks a clarifying question when the goal is ambiguous, and it **remembers the answer across sessions** so it never starts from zero.

---

## What was built for this hackathon (disclosure)

Per the **New Projects Only** rule, here is the exact boundary of what was created during the Submission Period (Aug 3–31, 2026):

**Built during the Submission Period — this repo (`waylo_agent`) and the client's `agent-cloud-demo` branch:**
- The entire **agent backend**: the **Genkit + Gemini 3.5** desktop planner (`planFlow`, `services/agent.js`), the **clarifying-question** flow, and the per-turn agent (`/agent/next`).
- The **orchestration**: the follow-up session loop that never dead-ends, clarify handling, and session memory that carries prior tasks into each follow-up plan.
- **Firestore** persistence (`services/memory.js`) and the **Google Cloud Run** deployment.
- The macOS client's **agent wiring** — Follow-up mode, the clarify UI, Right-⌘ voice / typed feedback capture — on the `agent-cloud-demo` branch.

**Pre-existing components carried in (built before Aug 3, 2026), named as such:**
- The macOS / Android **client shell** (window, notch panel, the talking red-dot overlay).
- The **on-device detection pipeline** (L0 Accessibility, L1 OCR, L2 / L2.5 YOLO) that turns a planned step into exact pixel coordinates.

**Standard tools / frameworks:** Genkit, Google GenAI SDK, Express, SwiftUI / AppKit.

The new agent layer lives in this **dedicated repository, created within the Submission Period**, so its commit history reflects the timeline. The pre-existing detection pipeline and learned-icon store remain on the original backend; what this hackathon added is the agentic brain, memory, and deployment above.

---

## What makes it an agent (and a *partner*)

A live loop, not a fixed script: **perceive → reason → act → verify → adapt** — plus **ask** and **remember**.

```mermaid
flowchart TD
    A["macOS / Android client<br/>reads the screen · draws the red dot"] -->|"goal + live screen + userId"| B
    subgraph GCP["Google Cloud"]
      B["Cloud Run<br/>Node/Express + Genkit agent"]
      F[("Firestore<br/>persistent memory")]
      B -->|"load past answers + goals"| F
      F -->|"remembered context"| B
      B -->|"save this turn"| F
    end
    B <-->|"structured-output flow"| C["Gemini 3.5<br/>gemini-3.5-flash"]
    B -.->|"continue · done · recover · clarify"| A
    A -.->|"user acts / answers → loop"| B
```

After each user action the client calls `POST /agent/next` with the updated screen, and the agent returns the **single** next decision: give the next step (`continue`), finish (`done`), get back on track (`recover`), or **ask a question** (`clarify`). What the user answers is stored in Firestore and reused next time.

## Hackathon requirements — how this repo meets them

| Requirement | How |
| --- | --- |
| **Gemini 3.5+** | `gemini-3.5-flash`, called on every agent turn |
| **Google Agent Framework** | **Genkit** — `services/agent.js` defines the `nextStep` flow with structured output |
| **Google Cloud service** | **Cloud Run** (host) **+ Firestore** (persistent memory) — two GCP services |

## The agent flow

`services/agent.js` is the brain: a Genkit `defineFlow` whose **structured output** forces Gemini to return exactly this decision — no fence-stripping, no chatty text:

```json
{
  "status": "continue | done | recover | clarify",
  "reasoning": "one short sentence",
  "action": {
    "instruction": "spoken step, e.g. \"Tap Notifications in the middle of the screen.\"",
    "findDescription": "rich text for on-device element search",
    "elementType": "LIST_ITEM",
    "screenRegion": "center",
    "visualDescription": "...",
    "alternateLabels": ["..."],
    "fallbackHint": "..."
  },
  "question": {
    "prompt": "Would you like to create a new document, or open an existing one?",
    "options": ["Create a new document", "Open an existing one"]
  }
}
```
`action` is null when `status` is `done` or `clarify`; `question` is present only when `status` is `clarify`.

## Persistent memory (Firestore)

`services/memory.js` stores, per `userId`, the answers the user has given to clarifying questions and the goals they've pursued. On every `/agent/next`, that memory is loaded and merged in — so **a brand-new session inherits what the user already told the agent, and it never re-asks.** Degrades to stateless if Firestore is absent (auto-enabled on Cloud Run).

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /agent/next` | **The agent.** `{ goal, appName?, appPackage?, screen?, userId?, history?, answers? }` → the decision above (plus `memoryUsed`) |
| `GET /` | Liveness |
| `POST /plan` | Legacy one-shot planner (kept for compatibility) |

Smoke-test:
```bash
curl -s -X POST https://waylo-agent-506434766076.asia-south1.run.app/agent/next \
  -H 'Content-Type: application/json' \
  -d '{"goal":"open a document","appName":"Pages","userId":"u1","screen":"Pages is open with a document titled Notes and a New button."}'
```

## Run it locally
```bash
npm install
AI_PROVIDER=gemini GEMINI_API_KEY=YOUR_KEY node index.js   # http://localhost:8080
```
Firestore stays off locally unless you set `ENABLE_FIRESTORE=1` (with GCP credentials).

## Deploy to Google Cloud Run
```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
gcloud firestore databases create --location=asia-south1                       # one-time
gcloud run deploy waylo-agent --source . --region asia-south1 --allow-unauthenticated --memory 512Mi \
  --set-env-vars AI_PROVIDER=gemini,GEMINI_TEXT_MODEL=gemini-3.5-flash,GEMINI_VISION_MODEL=gemini-3.5-flash,GEMINI_API_KEY=YOUR_KEY
```
Builds the Dockerfile on Cloud Build (no local Docker). On Cloud Run, Firestore auto-enables via `K_SERVICE` and uses the service account's default credentials.

## Environment
| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini 3.5 key from [AI Studio](https://aistudio.google.com/apikey) — **required** |
| `AI_PROVIDER` | `gemini` |
| `GEMINI_TEXT_MODEL` | `gemini-3.5-flash` |
| `FIRESTORE_COLLECTION` | memory collection (default `waylo_memory`) |
| `ENABLE_FIRESTORE` | `1` to use Firestore off Cloud Run |

## Layout
```
services/agent.js    the Genkit flow (defineFlow) + Gemini 3.5 + decision schema (incl. clarify)
services/memory.js   Firestore persistent cross-session memory
index.js             Express app; POST /agent/next
Dockerfile           Cloud Run container (node:20-slim)
```

The macOS and Android clients live in [waylo-1/frontend_systemsettings_overlay](https://github.com/waylo-1/frontend_systemsettings_overlay).

---

<div align="center">

**Part of [Waylo](https://github.com/waylo-1)** · Gemini 3.5 · Genkit · Cloud Run · Firestore

</div>
