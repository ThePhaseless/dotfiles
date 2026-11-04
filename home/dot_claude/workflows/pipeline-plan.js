export const meta = {
  name: 'pipeline-plan',
  description: 'Change pipeline stages 1-2: plan, then review and revise until the review has no blocker or major; returns the plan and any questions for the user, or stalled when a revision changes nothing',
  whenToUse: 'Every non-trivial change, before pipeline-implement. args: {request, repo, context?, plan?, issues?, answers?}. After the user answers, rerun with the returned plan, issues and the answers. After stalled, bring the open issues to the user.',
  phases: [{ title: 'Plan' }, { title: 'Plan review' }],
}

let a = args
if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = { request: a } } }
a = a && typeof a === 'object' ? a : {}
if (typeof a.request !== 'string' || !a.request.trim() || typeof a.repo !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(a.repo))
  return { status: 'no-args', next: 'Call again with args.request and args.repo (the absolute path of the repository).' }

const tryAgent = async (prompt, opts) => {
  try {
    const r = await agent(prompt, opts)
    if (r == null) log(`${opts.label}: no result (skipped, or died after retries)`)
    return r
  } catch (e) { log(`${opts.label}: ${String(e && e.message || e).slice(0, 200)}`); return null }
}
const STAGE = s => `You are the ${s} stage of the change pipeline; do this stage yourself and return its result.`
const QUESTIONS = { type: 'array', items: { type: 'object', required: ['question', 'why'],
  properties: { question: { type: 'string' }, why: { type: 'string', description: 'what in the plan depends on the answer' }, suggested: { type: 'string' } } } }
const PLAN = { type: 'object', required: ['plan', 'questions'],
  properties: { plan: { type: 'string', description: 'the full plan as Markdown, ending with the Units section' }, questions: QUESTIONS } }
const PLAN_REVIEW = { type: 'object', required: ['issues', 'questions'], properties: {
  issues: { type: 'array', items: { type: 'object', required: ['severity', 'issue', 'fix'], properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, issue: { type: 'string' }, fix: { type: 'string' } } } },
  questions: QUESTIONS } }

const text = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2)
const repoLine = `Repository: ${a.repo}. Read the code the change touches; leave every file unchanged.`
const given = () => [
  `Request:\n${a.request}`,
  a.context ? `Context from the orchestrator:\n${text(a.context)}` : '',
  a.answers ? `The user's answers to earlier questions. They are settled decisions:\n${text(a.answers)}` : '',
].filter(Boolean).join('\n\n')
const QUESTIONS_RULE = 'Put in `questions` only decisions that the request, the code and sound defaults cannot settle; for each, say what in the plan depends on the answer and suggest a default. Leave `questions` empty for everything else.'

const planPrompt = (plan, issues) => [
  STAGE('Plan'),
  repoLine,
  given(),
  plan ? `Previous plan, to revise:\n${plan}` : '',
  issues.length ? `Open review issues on that plan. The revised plan resolves each one:\n${text(issues)}` : '',
  `Write the plan into \`plan\` as Markdown with these sections:
1. Files: every file to create or change, and why. Include every place the change must reach: callers, tests, fixtures, config, exports.
2. Steps: the ordered steps.
3. Verification: the commands and checks that prove the change works.
4. Risks.
5. Units, as the last section. Split the work into units another agent implements one each. For each unit give:
   - id: U1, U2, ...
   - goal: what the unit delivers.
   - files: the repo-relative paths of the files or directories it creates or edits, written out in full (no globs). Include every manifest, lockfile, generated file and migration it changes.
   - dependsOn: ids of earlier units only.
   When two units share a file, the later one depends on the earlier one. Items that share no file and need nothing from each other stay in separate units so they run at once.

Write every assumption you make into the plan. The plan is done when an implementer could carry out each unit from the plan text alone.`,
  QUESTIONS_RULE,
].filter(Boolean).join('\n\n')

const reviewPrompt = (plan, issues) => [
  STAGE('Plan review'),
  repoLine,
  given(),
  `Plan:\n${plan}`,
  issues.length ? `Issues from the previous review. Check these are resolved; report new ones. Report a previous issue again only when the plan still leaves it open:\n${text(issues)}` : '',
  `Check the plan against the request and the code:
- It does everything the request asks, and only that.
- Every file it names exists or is created by the plan, and every place the change must reach (callers, tests, fixtures, config, exports) is listed.
- The steps run in an order that works, and the verification proves the change.
- Units: each unit's files cover every file it edits, including manifests, lockfiles, generated files and migrations; paths are repo-relative files or directories, written out in full; units that share a file depend on each other, the later on the earlier; dependsOn names earlier units only; independent items sit in separate units.

Report each problem in \`issues\` with a severity and a concrete fix:
- blocker: the plan would fail or break something.
- major: a wrong or missing part that the implementer would carry into the code.
- minor: polish.
The review is done when every check above has been made against the code. An empty \`issues\` list means the plan passes.`,
  QUESTIONS_RULE,
].filter(Boolean).join('\n\n')

let plan = a.plan, issues = Array.isArray(a.issues) ? a.issues : []
for (let round = 1; ; round++) {
  if (!(round === 1 && plan && !a.answers && !issues.length)) {        // otherwise review the given plan as is
    const p = await tryAgent(planPrompt(plan, issues), { label: 'plan:' + round, phase: 'Plan', schema: PLAN, effort: 'high' })
    if (!p) return { status: 'agent-failed', stage: 'plan', plan, issues }
    const prev = plan
    plan = p.plan
    if (p.questions.length) return { status: 'needs-user', plan, questions: p.questions, issues, round }
    // No round cap; an unchanged revision with blockers/majors open would loop forever. Round 1 of a rerun with answers is exempt: no reviewer has seen the answers yet.
    if ((round > 1 || !a.answers) && typeof prev === 'string' && prev.trim() === String(plan).trim() && issues.some(i => i.severity !== 'minor'))
      return { status: 'stalled', plan, issues, round }
  }
  const r = await tryAgent(reviewPrompt(plan, issues), { label: 'plan-review:' + round, phase: 'Plan review', schema: PLAN_REVIEW, effort: 'high' })
  if (!r) return { status: 'agent-failed', stage: 'plan review', plan, issues }
  issues = r.issues
  if (r.questions.length) return { status: 'needs-user', plan, questions: r.questions, issues, round }
  if (!issues.some(i => i.severity !== 'minor')) return { status: 'ready', plan, minorIssues: issues, round }
}
