/**
 * Waylo agent — the GenKit-powered "next step" brain.
 *
 * This is the agentic upgrade over the old one-shot /plan: instead of writing
 * the whole plan up front, the agent decides ONE action at a time, grounded in
 * the CURRENT screen and what has happened so far. After each user action the
 * Android app calls this again with the new screen, so the agent can verify,
 * continue, or recover when the screen isn't what it expected.
 *
 * Built on GenKit (Google's agent framework) + Gemini 3.5 with structured
 * output, so the model is forced to return exactly the JSON the Android Step
 * model already parses — no fence-stripping, no chatty text.
 */

const { genkit, z } = require('genkit');
const { googleAI } = require('@genkit-ai/google-genai');

// One GenKit instance, reused across requests (warm Cloud Run instances share it).
const ai = genkit({
  plugins: [googleAI({ apiKey: process.env.GEMINI_API_KEY })],
});

const MODEL = googleAI.model(process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash');

// Same element-type enum the Android app understands (see promptSpecs.js).
const ELEMENT_TYPES = [
  'BUTTON', 'ICON_BUTTON', 'FAB', 'TEXT_INPUT', 'NAV_ITEM', 'TOGGLE',
  'APP_ICON', 'LIST_ITEM', 'IMAGE', 'TAB', 'OVERFLOW_MENU', 'BACK_BUTTON', 'OTHER',
];

// One on-screen action — the same wire shape as a single step of /plan.
const ActionSchema = z.object({
  instruction: z.string().describe(
    'ONE short instruction SPOKEN ALOUD to an elderly user, max 14 words, names exactly ONE element and says WHERE in plain words (e.g. "at the top", "near the bottom").'
  ),
  findDescription: z.string().describe(
    'NOT spoken. Rich description for on-device search: every likely label, icon shape, and position this element could have.'
  ),
  elementType: z.enum(ELEMENT_TYPES),
  screenRegion: z.string().describe('physical position, e.g. top, bottom, center, top_center, bottom_right'),
  visualDescription: z.string().describe('what it looks like: colour, shape, icon, text — max 15 words'),
  alternateLabels: z.array(z.string()).describe('other labels this element might carry'),
  fallbackHint: z.string().describe('what to do if the element is not visible on screen'),
});

// The agent's decision each turn.
const DecisionSchema = z.object({
  status: z.enum(['continue', 'done', 'recover']).describe(
    'continue = give the next step; done = the goal is already complete on this screen; recover = the screen is not what a normal next step expects (pop-up, wrong app, error) so the action is a recovery move.'
  ),
  reasoning: z.string().describe('ONE short sentence: why this action, or why done, or what went wrong and how this recovers.'),
  action: ActionSchema.nullable().describe('the single next action; null ONLY when status is "done".'),
});

const SYSTEM = `You are Waylo, a calm, patient guide that helps a person — often an elderly or first-time smartphone user — do things on their OWN phone by pointing at exactly what to tap next.

You work ONE step at a time. You are given the user's GOAL, a description of the CURRENT screen, and the HISTORY of steps already done. Decide the single next thing to do.

Rules:
- "instruction" is spoken aloud. It must be ONE short, calm sentence, name exactly ONE element, and say WHERE it is in plain words. Never offer two options in the instruction.
- Put all the breadth (possible labels, icon shapes, positions) into "findDescription" and "alternateLabels", NOT into the spoken instruction.
- Pick "elementType" from the enum and "screenRegion" as the element's physical position.
- If the CURRENT screen already shows the goal is achieved, return status "done" with action null.
- If the CURRENT screen is NOT what a normal next step expects — a pop-up/dialog blocking the way, the wrong app in front, an error, or the user clearly tapped the wrong thing — return status "recover" and make the action the move that gets back on track (dismiss the dialog, go back, reopen the right screen).
- Otherwise return status "continue" with the next action.
- Never invent an element that is not plausibly on the described screen. If unsure what is on screen, guide the user to the most likely place to look.
- Safety: if the next real action is entering a password or confirming a payment/send/delete, still describe that step normally — the app pauses for the user's own confirmation. Never instruct the user to type a password value.`;

function buildPrompt({ goal, appName, screen, history }) {
  const hist = (history && history.length)
    ? history.map((h, i) => `  ${i + 1}. did: "${h.instruction}" → outcome: ${h.outcome || 'unknown'}`).join('\n')
    : '  (nothing yet — this is the first step)';
  return `GOAL: ${goal}
APP IN FRONT: ${appName || 'unknown'}

STEPS SO FAR:
${hist}

CURRENT SCREEN (what is visible right now):
${screen || '(no screen description provided — assume we are at the start and may need to open the right app/screen)'}

Decide the single next step now.`;
}

// The GenKit flow. Registered by name so it shows up in GenKit tracing.
const nextStepFlow = ai.defineFlow(
  {
    name: 'nextStep',
    inputSchema: z.object({
      goal: z.string(),
      appName: z.string().optional(),
      appPackage: z.string().optional(),
      screen: z.string().optional(),
      history: z.array(z.object({
        instruction: z.string(),
        outcome: z.string().optional(),
      })).optional(),
    }),
    outputSchema: DecisionSchema,
  },
  async ({ goal, appName, screen, history }) => {
    const { output } = await ai.generate({
      model: MODEL,
      system: SYSTEM,
      prompt: buildPrompt({ goal, appName, screen, history }),
      output: { schema: DecisionSchema },
      config: { temperature: 0.2 },
    });
    return output;
  }
);

module.exports = { ai, nextStepFlow, DecisionSchema, ActionSchema, ELEMENT_TYPES };
