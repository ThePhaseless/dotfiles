#!/usr/bin/env node
// Offline control-flow test for home/dot_claude/workflows/pipeline-{plan,implement}.js.
// Runs each script against fake agents keyed by label. Repo-only: never applied by chezmoi.
// Usage: node check-workflows.mjs   (exit 1 on any FAIL)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = {
  A: join(ROOT, 'home/dot_claude/workflows/pipeline-plan.js'),
  B: join(ROOT, 'home/dot_claude/workflows/pipeline-implement.js'),
}
const AsyncFunction = (async () => {}).constructor
const TIMEOUT_MS = 3000

// Scripts must be deterministic so a resumed run replays the same way.
class FakeDate extends Date {
  constructor(...a) { if (!a.length) throw new Error('new Date() is not allowed in a workflow script'); super(...a) }
  static now() { throw new Error('Date.now() is not allowed in a workflow script') }
}
const FakeMath = new Proxy(Math, {
  get: (t, k) => k === 'random' ? () => { throw new Error('Math.random() is not allowed in a workflow script') } : t[k],
})

const compiled = {}
const SCHEMAS = [] // [label, schema] from every agent() call in every scenario
function compile(which) {
  if (!compiled[which]) {
    const src = readFileSync(SCRIPTS[which], 'utf8').replace(/export\s+const\s+meta\s*=/, 'const meta =')
    compiled[which] = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'Date', 'Math',
      "'use strict';\n" + src)
  }
  return compiled[which]
}

// answers: { label | 'prefix:*': value | Error | (prompt, opts, ctx) => value }
async function runScript(which, args, answers = {}) {
  const ctx = { calls: [], logs: [], unanswered: [], inFlight: 0, maxImpl: 0, implInFlight: 0, seq: 0 }
  const agent = async (prompt, opts = {}) => {
    const label = String(opts.label)
    const call = { label, prompt: String(prompt), opts, start: ++ctx.seq, end: null }
    ctx.calls.push(call)
    if (opts.schema) SCHEMAS.push([label, opts.schema])
    const impl = label.startsWith('implement:')
    if (impl) ctx.maxImpl = Math.max(ctx.maxImpl, ++ctx.implInFlight)
    try {
      await new Promise(r => setTimeout(r, 0))
      const key = label in answers ? label : label.replace(/:[^:]*$/, ':*')
      if (!(key in answers)) { ctx.unanswered.push(label); throw new Error(`no fake answer for ${label}`) }
      let a = answers[key]
      if (typeof a === 'function') a = a(call.prompt, opts, ctx)
      if (a instanceof Error) throw a
      return structuredClone(a)
    } finally {
      call.end = ++ctx.seq
      if (impl) ctx.implInFlight--
    }
  }
  const parallel = ts => Promise.all(ts.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, fn) => Promise.all(items.map((x, i) => fn(x, i)))
  const log = m => { ctx.logs.push(String(m)) }
  const phase = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  let timer
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`script did not finish in ${TIMEOUT_MS} ms`)), TIMEOUT_MS) })
  try {
    ctx.result = await Promise.race([
      compile(which)(agent, parallel, pipeline, log, phase, args, budget, FakeDate, FakeMath),
      timeout,
    ])
  } finally { clearTimeout(timer) }
  return ctx
}

// ---- helpers for assertions ----
class Fail extends Error {}
const ok = (cond, why) => { if (!cond) throw new Fail(why) }
const labels = ctx => ctx.calls.map(c => c.label)
const call = (ctx, label) => ctx.calls.find(c => c.label === label)
const has = (ctx, label) => labels(ctx).includes(label)
const count = (ctx, re) => labels(ctx).filter(l => re.test(l)).length
const status = (ctx, want) => ok(ctx.result && ctx.result.status === want,
  `status ${JSON.stringify(ctx.result && ctx.result.status)}, want ${want}`)
const prompt = (ctx, label) => { const c = call(ctx, label); ok(c, `no ${label} call`); return c.prompt }
const contains = (ctx, label, s) => ok(prompt(ctx, label).includes(s), `${label} prompt lacks ${JSON.stringify(s)}`)
const lacks = (ctx, label, s) => ok(!prompt(ctx, label).includes(s), `${label} prompt contains ${JSON.stringify(s)}`)
const ids = list => (list || []).map(f => f.id)

// ---- fixtures ----
const T = c => c.repeat(40)
const [T0, T1, T2, T3] = [T('0'), T('1'), T('2'), T('3')]
const PLAN = 'PLAN-MARKER-7f3a: add a() and b().\n## Units\n- U1: a.py\n- U2: b.py'
const REPO = '/repo'
const Q = [{ question: 'Which default?', why: 'step 2 depends on it' }]
const issue = (severity, tag) => ({ severity, issue: `ISSUE-${tag}`, fix: `FIX-${tag}` })
const finding = (severity, tag, extra = {}) => ({ severity, file: 'a.py', line: 1, title: `TITLE-${tag}`, detail: `DETAIL-${tag}`, ...extra })
const unit = (id, files, dependsOn = []) => ({ id, goal: `GOAL-${id}`, files, dependsOn })
const done = files => ({ status: 'done', filesChanged: files, summary: 'ok' })
// The fixer answers every finding id of this round that its prompt names (R<round>P<n> / R<round>B<n>).
const fixAll = st => (p, o) => {
  const re = new RegExp(`R${o.label.split(':')[1]}[PB]\\d+`, 'g')
  const given = [...new Set(p.match(re) || [])]
  return { results: given.map(id => ({ id, status: st, note: `NOTE-${id}` })), filesChanged: ['a.py'] }
}
const bArgs = { plan: PLAN, repo: REPO }
const snap = (tree, changedFiles = ['a.py', 'b.py']) => ({ tree, changedFiles })
const splitOf = (units, over = {}) => ({ baseTree: T0, prefix: '', realRepo: REPO, fallback: false, units, ...over })
// a clean B run up to the first review; override keys per scenario
const B = (over = {}, units = [unit('U1', ['a.py']), unit('U2', ['b.py'])]) => ({
  split: splitOf(units),
  'implement:*': (p, o) => done((units.find(u => o.label === 'implement:' + u.id) || { files: [] }).files),
  'snapshot:1': { tree: T1, changedFiles: units.flatMap(u => u.files) },
  'review:plan:*': { findings: [] },
  'review:blind:*': { findings: [] },
  ...over,
})

// Two units whose files overlap must run in order, never at once.
const ordered = (name, f1, f2) => ({
  name: `B: ${JSON.stringify(f1)} vs ${JSON.stringify(f2)} -> ordered`, script: 'B', args: bArgs,
  answers: B({ 'snapshot:1': { tree: T1, changedFiles: [] } }, [unit('U1', f1), unit('U2', f2)]),
  check: ctx => {
    status(ctx, 'done')
    ok(ctx.maxImpl === 1, `${ctx.maxImpl} implement calls ran at once, want 1`)
    const u1 = call(ctx, 'implement:U1'), u2 = call(ctx, 'implement:U2')
    ok(u1 && u2 && u2.start > u1.end, 'implement:U2 started before implement:U1 finished')
    ok(ctx.logs.some(l => /U2 <- \[U1\]/.test(l)), 'no "U2 <- [U1]" log line')
  },
})

// The snapshot command for a repo path holding a space and a quote, written out by hand.
const QREPO = "/tmp/it's here"
const QGUARD = String.raw`cd '/tmp/it'\''s here' && { git rev-parse --show-toplevel >/dev/null 2>&1 || { echo NOT_GIT; false; }; }`
const QSNAP = QGUARD + String.raw` && idx="$(git rev-parse --path-format=absolute --git-path index).pipeline-snapshot" && rm -f "$idx" "$idx.lock" && { cp "$(git rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null; GIT_INDEX_FILE="$idx" git add -A && GIT_INDEX_FILE="$idx" git write-tree; }; s=$?; [ -z "$idx" ] || rm -f "$idx"; test "$s" = 0`
const QINFO = QGUARD + ' && echo "prefix=$(git rev-parse --show-prefix)" && echo "real=$(pwd -P)"'
const QNAMES = String.raw`git -C '/tmp/it'\''s here' -c core.quotePath=false diff --relative --no-renames --name-only`

// ---- the scenario table: add a row to add a test ----
const SCENARIOS = [
  // Workflow A
  { name: 'A: no request -> no-args', script: 'A', args: {}, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'A: undefined args -> no-args', script: 'A', args: undefined, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'A: JSON-string args are parsed', script: 'A', args: JSON.stringify({ request: 'REQ-JSON-41', repo: REPO }),
    answers: { 'plan:1': { plan: 'P', questions: Q } },
    check: ctx => { status(ctx, 'needs-user'); contains(ctx, 'plan:1', 'REQ-JSON-41'); lacks(ctx, 'plan:1', '{"request"') } },
  { name: 'A: plain-string args (request, no repo) -> no-args', script: 'A', args: 'REQ-PLAIN-42 add a thing', answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'A: relative repo -> no-args', script: 'A', args: { request: 'R', repo: 'repo' }, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'A: repo reaches the planner prompt', script: 'A', args: { request: 'R', repo: '/REPO-PATH-31' },
    answers: { 'plan:1': { plan: 'P', questions: Q } },
    check: ctx => { status(ctx, 'needs-user'); contains(ctx, 'plan:1', 'Repository: /REPO-PATH-31.') } },
  { name: 'A: planner asks questions -> needs-user, no review', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:1': { plan: 'P1', questions: Q } },
    check: ctx => {
      status(ctx, 'needs-user')
      ok(ctx.result.plan === 'P1', 'plan not returned')
      ok(JSON.stringify(ctx.result.questions) === JSON.stringify(Q), 'questions not returned')
      ok(!count(ctx, /^plan-review:/), 'reviewer was called')
    } },
  { name: 'A: reviewer returns issues and questions -> needs-user with issues', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:1': { plan: 'P1', questions: [] }, 'plan-review:1': { issues: [issue('major', 'M1')], questions: Q } },
    check: ctx => {
      status(ctx, 'needs-user')
      ok((ctx.result.issues || []).some(i => i.issue === 'ISSUE-M1'), 'issues missing from the result')
      ok(JSON.stringify(ctx.result.questions) === JSON.stringify(Q), 'questions not returned')
    } },
  { name: 'A: rerun with args.issues -> issues and old plan in planner prompt', script: 'A',
    args: { request: 'R', repo: REPO, plan: 'OLD-PLAN-99', issues: [issue('major', 'RERUN')], answers: 'ANSWER-77' },
    answers: { 'plan:1': { plan: 'P2', questions: [] }, 'plan-review:1': { issues: [], questions: [] } },
    check: ctx => {
      status(ctx, 'ready')
      for (const s of ['ISSUE-RERUN', 'OLD-PLAN-99', 'ANSWER-77']) contains(ctx, 'plan:1', s)
      ok(ctx.result.plan === 'P2', 'revised plan not returned')
    } },
  { name: 'A: rerun with issues, planner asks questions -> needs-user keeps issues', script: 'A',
    args: { request: 'R', repo: REPO, plan: 'OLD', issues: [issue('major', 'KEEP')] },
    answers: { 'plan:1': { plan: 'P2', questions: Q } },
    check: ctx => {
      status(ctx, 'needs-user')
      ok((ctx.result.issues || []).some(i => i.issue === 'ISSUE-KEEP'), 'open issues lost on the questions path')
    } },
  { name: 'A: given plan, no issues or answers -> reviewed as is', script: 'A', args: { request: 'R', repo: REPO, plan: 'GIVEN-PLAN-5' },
    answers: { 'plan-review:1': { issues: [issue('minor', 'm')], questions: [] } },
    check: ctx => {
      status(ctx, 'ready')
      ok(!count(ctx, /^plan:/), 'planner was called')
      contains(ctx, 'plan-review:1', 'GIVEN-PLAN-5')
      ok((ctx.result.minorIssues || []).length === 1, 'minorIssues not returned')
    } },
  { name: 'A: majors for 4 rounds, then clean -> ready after 5 reviews', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:*': (p, o) => ({ plan: 'PLAN-' + o.label, questions: [] }),
      'plan-review:*': (p, o) => ({ issues: o.label.endsWith(':5') ? [] : [issue('major', o.label)], questions: [] }) },
    check: ctx => {
      status(ctx, 'ready')
      ok(count(ctx, /^plan-review:/) === 5, `${count(ctx, /^plan-review:/)} reviews, want 5`)
      ok(count(ctx, /^plan:/) === 5, `${count(ctx, /^plan:/)} plans, want 5`)
      ok(ctx.result.plan === 'PLAN-plan:5' && ctx.result.round === 5, 'last plan or round not returned')
      contains(ctx, 'plan:2', 'ISSUE-plan-review:1')
      contains(ctx, 'plan-review:2', 'ISSUE-plan-review:1')
    } },
  { name: 'A: planner returns the same plan with majors open -> stalled', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:1': { plan: 'SAME-PLAN', questions: [] }, 'plan:2': { plan: '  SAME-PLAN\n', questions: [] },
      'plan-review:*': { issues: [issue('major', 'STUCK')], questions: [] } },
    check: ctx => {
      status(ctx, 'stalled')
      ok(ctx.result.round === 2 && ctx.result.plan.trim() === 'SAME-PLAN', 'round or plan wrong')
      ok((ctx.result.issues || []).some(i => i.issue === 'ISSUE-STUCK'), 'open issues missing')
      ok(!has(ctx, 'plan-review:2'), 'reviewed an unchanged plan')
    } },
  { name: 'A: rerun with answers, planner returns the identical plan in round 1 -> reviewed, not stalled', script: 'A',
    args: { request: 'R', repo: REPO, plan: 'SAME-PLAN', issues: [issue('major', 'Q')], answers: 'ANSWER-1' },
    answers: { 'plan:1': { plan: 'SAME-PLAN', questions: [] }, 'plan-review:1': { issues: [], questions: [] } },
    check: ctx => {
      status(ctx, 'ready')
      ok(has(ctx, 'plan-review:1'), 'plan not reviewed')
    } },
  { name: 'A: planner throws -> agent-failed', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:1': new Error('stalled') },
    check: ctx => { status(ctx, 'agent-failed'); ok(!count(ctx, /^plan-review:/), 'reviewer was called') } },
  { name: 'A: reviewer throws -> agent-failed', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:1': { plan: 'P1', questions: [] }, 'plan-review:1': new Error('stalled') },
    check: ctx => { status(ctx, 'agent-failed'); ok(ctx.result.plan === 'P1', 'plan not returned') } },

  // Workflow B: args
  { name: 'B: no repo -> no-args', script: 'B', args: { plan: PLAN }, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'B: no plan -> no-args', script: 'B', args: { repo: REPO }, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'B: plain-string args (plan, no repo) -> no-args', script: 'B', args: 'just a plan', answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'B: JSON-string args are parsed', script: 'B', args: JSON.stringify(bArgs), answers: B(),
    check: ctx => { status(ctx, 'done'); contains(ctx, 'split', 'PLAN-MARKER-7f3a') } },

  // Workflow B: split and units
  { name: 'B: split throws -> split-failed', script: 'B', args: bArgs, answers: { split: new Error('stalled') },
    check: ctx => { status(ctx, 'split-failed'); ok(!count(ctx, /^implement:/), 'implementers were called') } },
  { name: 'B: duplicate unit ids -> bad-units', script: 'B', args: bArgs,
    answers: B({}, [unit('U1', ['a.py']), unit('U1', ['b.py'])]),
    check: ctx => { status(ctx, 'bad-units'); ok(!count(ctx, /^implement:/), 'implementers were called') } },
  { name: 'B: two independent units -> run at once', script: 'B', args: bArgs, answers: B(),
    check: ctx => { status(ctx, 'done'); ok(ctx.maxImpl >= 2, `max ${ctx.maxImpl} implement calls at once, want >= 2`) } },
  ordered('readme', ['./README.md'], ['README.md']),
  ordered('dir', ['docs'], ['docs/a.md']),
  ordered('trailing slash', ['docs/'], ['docs/a.md']),
  ordered('absolute', [REPO + '/a.py'], ['a.py']),
  ordered('dot', ['.'], ['b.py']),
  { name: 'B: failed dependency -> dependent never called, implement-failed', script: 'B', args: bArgs,
    answers: B({ 'implement:U1': { status: 'blocked', filesChanged: [], summary: 'no', blocker: 'needs c.py' } },
      [unit('U1', ['a.py']), unit('U2', ['b.py'], ['U1'])]),
    check: ctx => {
      status(ctx, 'implement-failed')
      ok(!has(ctx, 'implement:U2'), 'implement:U2 was called')
      ok(ctx.result.baseTree === T0, 'baseTree missing from implement-failed')
      ok(!has(ctx, 'snapshot:1'), 'snapshot ran after a failed implement')
    } },
  { name: 'B: implement throws -> implement-failed', script: 'B', args: bArgs,
    answers: B({ 'implement:U2': new Error('stalled') }),
    check: ctx => { status(ctx, 'implement-failed'); ok(!has(ctx, 'snapshot:1'), 'snapshot ran after a failed implement') } },
  { name: 'B: snapshot throws -> snapshot-failed', script: 'B', args: bArgs, answers: B({ 'snapshot:1': new Error('stalled') }),
    check: ctx => { status(ctx, 'snapshot-failed'); ok(!count(ctx, /^review:/), 'reviewers were called') } },

  // Workflow B: review loop
  { name: 'B: no findings -> done', script: 'B', args: bArgs, answers: B(),
    check: ctx => {
      status(ctx, 'done')
      ok(!count(ctx, /^fix:/), 'fixer was called')
      ok(ctx.result.baseTree === T0 && ctx.result.finalTree === T1, 'baseTree/finalTree wrong')
      ok((ctx.result.rounds || []).length === 1, 'want 1 round')
      ok((ctx.result.open || []).length === 0, 'open not empty')
    } },
  { name: 'B: only minor findings -> fix, no re-review, done', script: 'B', args: bArgs,
    answers: B({ 'review:blind:1': { findings: [finding('minor', 'm')] }, 'fix:1': fixAll('fixed') }),
    check: ctx => {
      status(ctx, 'done')
      ok(has(ctx, 'fix:1'), 'fixer not called')
      ok(!has(ctx, 'snapshot:2') && !count(ctx, /^review:.*:2$/), 're-reviewed after a minors-only fix')
    } },
  { name: 'B: new majors in rounds 1-4, clean round 5 -> done, 4 fixes', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: o.label.endsWith(':5') ? [] : [finding('major', o.label)] }),
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'done')
      ok(count(ctx, /^fix:/) === 4, `${count(ctx, /^fix:/)} fix calls, want 4`)
      ok(has(ctx, 'review:plan:5') && !has(ctx, 'review:plan:6'), 'want exactly 5 review rounds')
      ok(ctx.result.finalTree === T('5'), 'finalTree is not the round-5 tree')
    } },
  { name: 'B: round 4 with only minors still fixes, then done', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: [finding(o.label.endsWith(':4') ? 'minor' : 'major', o.label)] }),
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'done')
      ok(has(ctx, 'fix:4'), 'no fix after a minors-only round 4')
      ok(!has(ctx, 'snapshot:5') && !has(ctx, 'review:plan:5'), 're-reviewed after a minors-only round')
    } },
  { name: 'B: finding fixed twice comes back -> escalate, finding keeps returning', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: [finding('major', 'X', o.label.endsWith(':3') ? { title: 'title-x' } : {})] }),
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'escalate')
      ok(ctx.result.note === 'finding keeps returning', `note ${JSON.stringify(ctx.result.note)}`)
      ok(count(ctx, /^fix:/) === 2 && !has(ctx, 'fix:3'), `${count(ctx, /^fix:/)} fix calls, want 2`)
      ok(ids(ctx.result.open).includes('R3P1'), 'returning R3P1 not in open')
    } },
  { name: 'B: same finding from both reviewers in round 1, back in round 2 -> one fix round, fix:2 runs', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: o.label.endsWith(':3') ? [] : [finding('major', 'X')] }),
      'review:blind:1': { findings: [finding('major', 'X')] },
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'done')
      ok(has(ctx, 'fix:2'), 'one round counted as two fixes')
    } },
  { name: 'B: re-titled regression linked by regressionOf, fixed in rounds 1-2, back in 3 -> escalate', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => {
        const r = +o.label.split(':')[2]
        return { findings: [finding('major', 'RT' + r, { file: `f${r}.py`, ...(r > 1 ? { regressionOf: `R${r - 1}P1` } : {}) })] }
      },
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'escalate')
      ok(ctx.result.note === 'finding keeps returning', `note ${JSON.stringify(ctx.result.note)}`)
      ok(count(ctx, /^fix:/) === 2 && !has(ctx, 'fix:3'), `${count(ctx, /^fix:/)} fix calls, want 2`)
      ok(ids(ctx.result.open).includes('R3P1'), 'returning R3P1 not in open')
    } },
  { name: 'B: finding fixed twice as minor, back as major -> not escalated by the returning rule', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: +o.label.split(':')[2] < 3 ? [finding('major', o.label)] : [] }),
      'review:blind:*': (p, o) => ({ findings: +o.label.split(':')[2] < 4 ? [finding(o.label.endsWith(':3') ? 'major' : 'minor', 'MX')] : [] }),
      'fix:*': fixAll('fixed'), 'snapshot:*': (p, o) => snap(T(o.label.split(':')[1])) }),
    check: ctx => {
      status(ctx, 'done')
      ok(has(ctx, 'fix:3'), 'minor fixes counted toward fixed twice')
    } },
  { name: 'B: declined major + unchanged tree -> escalate, no re-review', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'D')] }, 'fix:1': fixAll('declined'), 'snapshot:2': snap(T1) }),
    check: ctx => {
      status(ctx, 'escalate')
      ok(has(ctx, 'snapshot:2'), 'no snapshot after the fix')
      ok(!count(ctx, /^review:.*:2$/), 're-reviewed an unchanged tree')
      ok(ids(ctx.result.open).includes('R1P1'), 'declined R1P1 not in open')
    } },
  { name: 'B: declined major, next round clean -> escalate', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'D')] }, 'fix:1': fixAll('declined'), 'snapshot:2': snap(T2) }),
    check: ctx => {
      status(ctx, 'escalate')
      ok(has(ctx, 'review:plan:2'), 'round 2 not reviewed')
      ok(ids(ctx.result.open).includes('R1P1'), 'declined R1P1 not in open')
    } },
  { name: 'B: reviewer throws -> review-failed, logged', script: 'B', args: bArgs,
    answers: B({ 'snapshot:1': { tree: T1, changedFiles: ['a.py', 'stray.txt'] }, 'review:blind:1': new Error('stalled-XYZ') }),
    check: ctx => {
      status(ctx, 'review-failed')
      ok(ctx.result.baseTree === T0, 'baseTree missing from review-failed')
      ok((ctx.result.unexpectedFiles || []).includes('stray.txt'), 'unexpectedFiles missing from review-failed')
      ok(ctx.logs.some(l => l.includes('review:blind:1')), 'reviewer failure not logged under its label')
      ok(!count(ctx, /^fix:/), 'fixer was called')
    } },
  { name: 'B: fixer throws -> fix-failed', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'F')] }, 'fix:1': new Error('stalled') }),
    check: ctx => { status(ctx, 'fix-failed'); ok(ids(ctx.result.open).includes('R1P1'), 'R1P1 not in open') } },
  { name: 'B: unexpected file -> in plan-check prompt and result, not in blind prompt', script: 'B', args: bArgs,
    answers: B({
      'implement:U1': done(['a.py', 'stray-impl.py']),
      'snapshot:1': { tree: T1, changedFiles: ['a.py', 'b.py', 'docs/new.md', 'stray-extra.txt'] },
    }, [unit('U1', ['a.py']), unit('U2', ['b.py']), unit('U3', ['docs'])]),
    check: ctx => {
      status(ctx, 'done')
      const u = ctx.result.unexpectedFiles || []
      ok(u.includes('stray-extra.txt'), 'stray-extra.txt not in unexpectedFiles')
      ok(!u.includes('a.py') && !u.includes('docs/new.md'), `covered files listed as unexpected: ${u}`)
      contains(ctx, 'review:plan:1', 'stray-extra.txt')
      lacks(ctx, 'review:blind:1', 'stray-extra.txt')
      ok(ctx.logs.some(l => l.includes('stray-extra.txt')), 'unexpected file not logged')
      ok(ctx.logs.some(l => l.includes('stray-impl.py')), 'filesChanged outside the unit not logged')
    } },
  { name: 'B: round 2 gets settled ids and round 1 to-tree; blind gets no detail', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'P')] }, 'review:blind:1': { findings: [finding('minor', 'B')] },
      'fix:1': fixAll('fixed'), 'snapshot:2': snap(T2) }),
    check: ctx => {
      status(ctx, 'done')
      for (const l of ['review:plan:2', 'review:blind:2']) for (const s of ['R1P1', 'R1B1', T1, T2]) contains(ctx, l, s)
      for (const l of ['review:plan:1', 'review:blind:1']) for (const s of [T0, T1]) contains(ctx, l, s)
      lacks(ctx, 'review:blind:2', 'DETAIL-P')
      const r = ctx.result.rounds || []
      ok(r.length === 2 && r[1].from === T1 && r[1].to === T2 && r[0].from === T0, 'rounds from/to wrong')
      ok(ctx.result.finalTree === T2, 'finalTree is not the last reviewed tree')
      ok(['R1P1', 'R1B1'].every(id => ids(ctx.result.settled).includes(id)), 'settled lacks round-1 ids')
    } },
  { name: 'B: blind prompts never contain the plan, goals, details, fixer notes or unexpected files', script: 'B', args: bArgs,
    answers: B({ 'review:plan:*': (p, o) => ({ findings: o.label.endsWith(':3') ? [] : [finding('major', o.label)] }), 'fix:*': fixAll('fixed'),
      'snapshot:1': snap(T1, ['a.py', 'stray-leak-1.txt']),
      'snapshot:2': snap(T2, ['a.py', 'stray-leak-1.txt']), 'snapshot:3': snap(T3, ['a.py', 'stray-leak-1.txt', 'stray-leak-3.txt']) }),
    check: ctx => {
      status(ctx, 'done')
      const blind = ctx.calls.filter(c => c.label.startsWith('review:blind:'))
      ok(blind.length === 3, `${blind.length} blind reviews, want 3`)
      for (const c of blind) for (const s of ['PLAN-MARKER-7f3a', 'GOAL-U1', 'GOAL-U2', 'DETAIL-review', 'NOTE-', 'stray-leak'])
        ok(!c.prompt.includes(s), `${c.label} prompt contains ${s}`)
      contains(ctx, 'review:plan:1', 'PLAN-MARKER-7f3a')
      contains(ctx, 'review:plan:2', 'NOTE-R1P1')
      contains(ctx, 'review:plan:3', 'stray-leak-3.txt')
    } },
  { name: 'B: SNAP_CMD and diff commands quote a repo path holding a space and a quote', script: 'B',
    args: { plan: PLAN, repo: QREPO }, answers: B({ split: splitOf([unit('U1', ['a.py'])], { realRepo: QREPO }) }, [unit('U1', ['a.py'])]),
    check: ctx => {
      status(ctx, 'done')
      contains(ctx, 'split', QINFO + '\n'); contains(ctx, 'split', QSNAP + '\n')
      contains(ctx, 'snapshot:1', QSNAP + '\n'); contains(ctx, 'snapshot:1', `${QNAMES} ${T0} <tree>`)
      contains(ctx, 'review:plan:1', String.raw`git -C '/tmp/it'\''s here' diff --relative ${T0} ${T1}`)
    } },
  { name: 'B: agent returns null -> failure status, label logged', script: 'B', args: bArgs, answers: { split: null },
    check: ctx => { status(ctx, 'split-failed'); ok(ctx.logs.some(l => l.startsWith('split:')), 'null result not logged under its label') } },
  { name: 'B: blind reviewer returns null -> review-failed with the plan check\'s findings', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'SURV')] }, 'review:blind:1': null }),
    check: ctx => {
      status(ctx, 'review-failed')
      ok((ctx.result.survivingFindings || []).some(f => f.title === 'TITLE-SURV'), 'surviving findings missing')
      ok(ctx.logs.some(l => l.startsWith('review:blind:1:')), 'null reviewer not logged under its label')
    } },
  { name: 'B: not a git repo -> not-git, no implementers', script: 'B', args: bArgs,
    answers: { split: splitOf([unit('U1', ['a.py'])], { baseTree: undefined, prefix: '', realRepo: '', error: 'NOT_GIT' }) },
    check: ctx => {
      status(ctx, 'not-git'); ok(!count(ctx, /^implement:/), 'implementers were called')
      ok(ctx.logs.some(l => l.includes('NOT_GIT')), 'reason not logged')
    } },
  { name: 'B: split without a tree id -> split-failed', script: 'B', args: bArgs,
    answers: { split: splitOf([unit('U1', ['a.py'])], { baseTree: undefined }) },
    check: ctx => { status(ctx, 'split-failed'); ok(!count(ctx, /^implement:/), 'implementers were called') } },
  { name: 'B: snapshot reports an error -> snapshot-failed, reason logged', script: 'B', args: bArgs,
    answers: B({ 'snapshot:1': { error: 'fatal: SNAP-ERR-9' } }),
    check: ctx => {
      status(ctx, 'snapshot-failed'); ok(!count(ctx, /^review:/), 'reviewers were called')
      ok(ctx.logs.some(l => l.includes('SNAP-ERR-9')), 'reason not logged')
    } },
  { name: 'B: monorepo prefix and symlinked repo path map to the unit files', script: 'B', args: bArgs,
    answers: B({
      split: splitOf([unit('U1', ['sub/a.py']), unit('U2', ['b.py'])], { prefix: 'sub/', realRepo: '/private/repo' }),
      'implement:U1': done(['sub/a.py', '/private/repo/a.py']),
      'implement:U2': done(['/repo/b.py']),
      'snapshot:1': { ...snap(T1, ['a.py', 'b.py']), rootFiles: ['sub/a.py', 'sub/b.py'] },
    }),
    check: ctx => {
      status(ctx, 'done')
      ok(!(ctx.result.unexpectedFiles || []).length, `unexpected: ${ctx.result.unexpectedFiles}`)
      ok(!(ctx.result.outsideScope || []).length, `outsideScope: ${ctx.result.outsideScope}`)
      ok(!ctx.logs.some(l => /outside/.test(l)), `logged as outside: ${ctx.logs.filter(l => /outside/.test(l))}`)
      ok(ctx.result.units[0].files[0] === 'a.py', `unit file is ${ctx.result.units[0].files[0]}`)
      contains(ctx, 'snapshot:1', `git -C '/repo' -c core.quotePath=false diff --relative --no-renames --name-only ${T0}`)
      contains(ctx, 'snapshot:1', `git -C '/repo' -c core.quotePath=false diff --no-renames --name-only ${T0} <tree>`)
      contains(ctx, 'review:blind:1', `git -C '/repo' diff --relative ${T0} ${T1}`)
    } },
  { name: 'B: args.baseTree -> split takes no snapshot, review starts from it', script: 'B', args: { ...bArgs, baseTree: T3 },
    answers: B({ split: splitOf([unit('U1', ['a.py'])], { baseTree: undefined }) }, [unit('U1', ['a.py'])]),
    check: ctx => {
      status(ctx, 'done')
      lacks(ctx, 'split', 'write-tree'); contains(ctx, 'split', 'echo NOT_GIT')
      ok(ctx.result.baseTree === T3, `baseTree ${ctx.result.baseTree}, want T3`)
      contains(ctx, 'snapshot:1', `--name-only ${T3} <tree>`)
      contains(ctx, 'review:plan:1', `diff --relative ${T3} ${T1}`)
    } },
  { name: 'B: monorepo root file changed -> outsideScope in result, both review prompts, log', script: 'B', args: bArgs,
    answers: B({
      split: splitOf([unit('U1', ['a.py'])], { prefix: 'sub/' }),
      'snapshot:1': { ...snap(T1, ['a.py']), rootFiles: ['sub/a.py', 'pnpm-lock.yaml', '.github/ci.yml'] },
    }, [unit('U1', ['a.py'])]),
    check: ctx => {
      status(ctx, 'done')
      ok(JSON.stringify(ctx.result.outsideScope) === '["pnpm-lock.yaml",".github/ci.yml"]', `outsideScope ${JSON.stringify(ctx.result.outsideScope)}`)
      for (const l of ['review:plan:1', 'review:blind:1']) for (const s of ['outside the repository scope', '- pnpm-lock.yaml', '- .github/ci.yml']) contains(ctx, l, s)
      lacks(ctx, 'review:blind:1', 'PLAN-MARKER-7f3a')
      ok(ctx.logs.some(l => l.includes('pnpm-lock.yaml')), 'outside-scope file not logged')
    } },
  { name: 'B: monorepo snapshot without rootFiles -> snapshot-failed', script: 'B', args: bArgs,
    answers: B({ split: splitOf([unit('U1', ['a.py'])], { prefix: 'sub/' }), 'snapshot:1': snap(T1, ['a.py']) }, [unit('U1', ['a.py'])]),
    check: ctx => { status(ctx, 'snapshot-failed'); ok(!count(ctx, /^review:/), 'reviewers were called') } },
  { name: 'B: no prefix -> snapshot runs no root-level command', script: 'B', args: bArgs, answers: B(),
    check: ctx => { status(ctx, 'done'); lacks(ctx, 'snapshot:1', 'rootFiles') } },
  { name: 'B: args.baseTree -> split checks it exists; missing -> split-failed', script: 'B', args: { ...bArgs, baseTree: T3 },
    answers: { split: splitOf([unit('U1', ['a.py'])], { baseTree: undefined, error: 'fatal: Not a valid object name\nBAD_BASE_TREE' }) },
    check: ctx => {
      status(ctx, 'split-failed'); ok(!count(ctx, /^implement:/), 'implementers were called')
      contains(ctx, 'split', `git -C '/repo' cat-file -e '${T3}^{tree}' || { echo BAD_BASE_TREE; false; }`)
      ok(String(ctx.result.detail).includes(T3) && /object store/.test(ctx.result.detail), `detail ${ctx.result.detail}`)
    } },
  { name: 'B: no args.baseTree -> split runs no cat-file check', script: 'B', args: bArgs, answers: B(),
    check: ctx => { status(ctx, 'done'); lacks(ctx, 'split', 'cat-file') } },
  { name: 'B: notRun from every round surfaces at top level, deduplicated', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'N')], notRun: ['chezmoi apply', 'npm install'] },
      'review:plan:2': { findings: [], notRun: ['chezmoi apply', 'deploy'] }, 'fix:1': fixAll('fixed'), 'snapshot:2': snap(T2) }),
    check: ctx => {
      status(ctx, 'done')
      ok(JSON.stringify(ctx.result.notRun) === '["chezmoi apply","npm install","deploy"]', `notRun ${JSON.stringify(ctx.result.notRun)}`)
    } },
  { name: 'B: review-failed carries notRun, including the surviving reviewer\'s', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [], notRun: ['migrate'] }, 'review:blind:1': null }),
    check: ctx => { status(ctx, 'review-failed'); ok(JSON.stringify(ctx.result.notRun) === '["migrate"]', `notRun ${JSON.stringify(ctx.result.notRun)}`) } },
  { name: 'B: bad args.baseTree -> no-args', script: 'B', args: { ...bArgs, baseTree: 'HEAD' }, answers: {},
    check: ctx => { status(ctx, 'no-args'); ok(!ctx.calls.length, 'agents were called') } },
  { name: 'B: implement-failed names the rerun with baseTree', script: 'B', args: bArgs,
    answers: B({ 'implement:U1': { status: 'blocked', filesChanged: [], summary: 'no', blocker: 'x' } }),
    check: ctx => { status(ctx, 'implement-failed'); ok(String(ctx.result.next).includes(T0), 'next lacks the baseTree') } },
  { name: 'B: claimed fixed but tree unchanged -> escalate with that finding open', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'C')] }, 'fix:1': fixAll('fixed'), 'snapshot:2': snap(T1) }),
    check: ctx => {
      status(ctx, 'escalate')
      ok(ids(ctx.result.open).includes('R1P1'), 'claimed-fixed R1P1 not in open')
      ok(!count(ctx, /^review:.*:2$/), 're-reviewed an unchanged tree')
    } },
  { name: 'B: unexpectedFiles recomputed after a fix round', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'U')] }, 'fix:1': fixAll('fixed'),
      'snapshot:1': snap(T1, ['a.py', 'stray-1.txt']), 'snapshot:2': snap(T2, ['a.py', 'stray-2.txt']) }),
    check: ctx => {
      status(ctx, 'done')
      contains(ctx, 'review:plan:1', 'stray-1.txt'); contains(ctx, 'review:plan:2', 'stray-2.txt'); lacks(ctx, 'review:plan:2', 'stray-1.txt')
      ok(JSON.stringify(ctx.result.unexpectedFiles) === '["stray-2.txt"]', `unexpectedFiles ${JSON.stringify(ctx.result.unexpectedFiles)}`)
      ok(ctx.logs.some(l => l.includes('stray-2.txt')), 'new unexpected file not logged')
    } },
  { name: 'B: plan without Units -> fallback logged', script: 'B', args: bArgs,
    answers: B({ split: splitOf([unit('U1', ['a.py'])], { fallback: true }) }, [unit('U1', ['a.py'])]),
    check: ctx => { status(ctx, 'done'); ok(ctx.logs.some(l => /no Units section/.test(l)), 'fallback not logged') } },
  { name: 'B: fixer is told to leave other files alone', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('minor', 'K')] }, 'fix:1': fixAll('fixed') }),
    check: ctx => { status(ctx, 'done'); contains(ctx, 'fix:1', 'Never revert, delete or rewrite any other file'); contains(ctx, 'fix:1', '- b.py') } },
  { name: 'B: every prompt opens with its stage line', script: 'B', args: bArgs,
    answers: B({ 'review:plan:1': { findings: [finding('major', 'S')] }, 'fix:1': fixAll('fixed'), 'snapshot:2': snap(T2) }),
    check: ctx => {
      status(ctx, 'done')
      for (const c of ctx.calls) ok(/^You are the .+ stage of the change pipeline; do this stage yourself/.test(c.prompt),
        `${c.label} prompt does not open with the stage line`)
    } },
  { name: 'A: every prompt opens with its stage line', script: 'A', args: { request: 'R', repo: REPO },
    answers: { 'plan:*': (p, o) => ({ plan: 'P-' + o.label, questions: [] }), 'plan-review:1': { issues: [issue('major', 'x')], questions: [] },
      'plan-review:2': { issues: [], questions: [] } },
    check: ctx => {
      status(ctx, 'ready')
      for (const c of ctx.calls) ok(/^You are the .+ stage of the change pipeline; do this stage yourself/.test(c.prompt),
        `${c.label} prompt does not open with the stage line`)
    } },
]

let failed = 0
for (const s of SCENARIOS) {
  let ctx
  try {
    ctx = await runScript(s.script, s.args, s.answers)
    s.check(ctx)
    console.log(`PASS ${s.name}`)
  } catch (e) {
    failed++
    const why = e instanceof Fail ? e.message : `${e && e.name}: ${e && e.message}`
    const extra = ctx ? ` [calls: ${labels(ctx).join(', ') || 'none'}${ctx.unanswered.length ? `; unanswered: ${ctx.unanswered.join(', ')}` : ''}]` : ''
    console.log(`FAIL ${s.name}: ${why}${extra}`)
  }
}
// Every schema passed to agent() must keep required within properties, at every level.
const badSchema = (sch, path) => !sch || typeof sch !== 'object' ? [] : [
  ...(sch.required || []).filter(k => !(sch.properties && k in sch.properties)).map(k => `${path}.required ${k}`),
  ...Object.entries(sch.properties || {}).flatMap(([k, v]) => badSchema(v, `${path}.${k}`)),
  ...badSchema(sch.items, `${path}[]`),
]
const schemaErrs = [...new Set(SCHEMAS.flatMap(([l, sch]) => badSchema(sch, l)))]
const total = SCENARIOS.length + 1
if (schemaErrs.length) { failed++; console.log(`FAIL schemas: required not in properties: ${schemaErrs.join('; ')}`) }
else console.log(`PASS schemas: required within properties (${SCHEMAS.length} agent calls)`)
console.log(`\n${total - failed}/${total} passed`)
process.exitCode = failed ? 1 : 0
