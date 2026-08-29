/**
 * Curated, LOCKED demo plans for the hackathon video.
 *
 * When a task matches one of these, /plan returns the exact steps below instead
 * of asking Gemini — so a scripted demo runs identically on every take. The plan
 * carries `demo: true`, which the client treats as LOCKED (a mid-run correction
 * only relabels a step, never rewrites the sequence). These bypass the LLM;
 * every other task still goes through the GenKit + Gemini 3.5 planner.
 *
 * Kept deliberately small and specific so it never shadows a real user task.
 */

const DEMO_PLANS = [
  {
    // Follow-up after "create a Gemini API key": creating a new AI-Studio project.
    // Fires for "create/make/start/how to ... new project".
    match: (t) => /\bnew project\b/.test(t) && /\b(create|make|start|add|how)\b/.test(t),
    plan: {
      task: 'Create a new project',
      app: 'Safari', // already frontmost (a follow-up); the client won't reopen it
      steps: [
        {
          index: 1,
          action: 'click',
          instruction: 'Click Projects in the toolbar on the right.',
          targetLabel: 'Projects',
          findDescription: 'the Projects button in the top-right toolbar',
          elementDescription: 'Projects button in the top-right toolbar',
          screenRegion: 'fullScreen',
          targetType: 'text',
          controlKind: 'button',
          key: null,
        },
        {
          index: 2,
          action: 'click',
          instruction: "Click 'Create a new project'.",
          targetLabel: 'Create a new project',
          findDescription: "the '+ Create a new project' button",
          elementDescription: "'+ Create a new project' button",
          screenRegion: 'fullScreen',
          targetType: 'text',
          controlKind: 'button',
          key: null,
        },
        {
          index: 3,
          action: 'type',
          instruction: 'Type a name for your project.',
          targetLabel: '',
          findDescription: 'the project name text field',
          elementDescription: 'the project name input field',
          screenRegion: 'dialog',
          targetType: 'text',
          controlKind: 'field',
          key: null,
        },
        {
          index: 4,
          action: 'click',
          instruction: "Click 'Create project'.",
          targetLabel: 'Create project',
          findDescription: 'the blue Create project button',
          elementDescription: 'the Create project confirmation button',
          screenRegion: 'dialog',
          targetType: 'text',
          controlKind: 'button',
          key: null,
        },
      ],
    },
  },
];

/** Returns a locked demo plan for `task`, or null if none matches. */
function matchDemoPlan(task) {
  const t = (task || '').toLowerCase().trim();
  if (!t) return null;
  for (const d of DEMO_PLANS) {
    try { if (d.match(t)) return { ...d.plan, demo: true }; } catch (_) {}
  }
  return null;
}

module.exports = { matchDemoPlan };
