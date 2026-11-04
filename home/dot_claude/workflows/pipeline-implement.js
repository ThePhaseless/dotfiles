export const meta = {
  name: 'pipeline-implement',
  description: 'Change pipeline stages 3-4: implement an approved plan unit by unit, independent units at once, then plan-check and blind reviews with fix rounds on the delta until a round has no blocker or major; escalates when the fixer stalls',
  whenToUse: 'After pipeline-plan returns ready and the orchestrator approves the plan. args: {plan, repo, baseTree?}. One run per working tree at a time. After implement-failed, fix the blocker and rerun with the same args plus the returned baseTree, so review covers all work since the original base.',
  phases: [{ title: 'Split' }, { title: 'Implement' }, { title: 'Review' }, { title: 'Fix' }],
}

let a = args
if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = { plan: a } } }
a = a && typeof a === 'object' ? a : {}
const HEX = /^[0-9a-f]{40,64}$/
if (typeof a.plan !== 'string' || !a.plan.trim() || typeof a.repo !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(a.repo)
  || (a.baseTree !== undefined && !(typeof a.baseTree === 'string' && HEX.test(a.baseTree))))
  return { status: 'no-args', next: 'Call again with args.plan (the approved plan text), args.repo (the absolute path of the working tree) and, optionally, args.baseTree (a 40 or 64 hex character tree id from an earlier run).' }

const tryAgent = async (prompt, opts) => {
  try {
    const r = await agent(prompt, opts)
    if (r == null) log(`${opts.label}: no result (skipped, or died after retries)`)
    return r
  } catch (e) { log(`${opts.label}: ${String(e && e.message || e).slice(0, 200)}`); return null }
}
const STAGE = s => `You are the ${s} stage of the change pipeline; do this stage yourself and return its result.`

const plan = a.plan, repo = a.repo.replace(/(.)\/+$/, '$1')
const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const R = sq(repo)
// Fails with NOT_GIT and a non-zero exit when repo is not inside a git work tree.
const GUARD = `cd ${R} && { git rev-parse --show-toplevel >/dev/null 2>&1 || { echo NOT_GIT; false; }; }`
const INFO_CMD = `${GUARD} && echo "prefix=$(git rev-parse --show-prefix)" && echo "real=$(pwd -P)"`
// Records the whole working tree as a tree id through a temp index; the user's index, HEAD and branches stay untouched. Exits non-zero on any failure.
const SNAP_CMD = `${GUARD} && idx="$(git rev-parse --path-format=absolute --git-path index).pipeline-snapshot" && rm -f "$idx" "$idx.lock" && { cp "$(git rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null; GIT_INDEX_FILE="$idx" git add -A && GIT_INDEX_FILE="$idx" git write-tree; }; s=$?; [ -z "$idx" ] || rm -f "$idx"; test "$s" = 0`
// Scoped to repo (a monorepo subdirectory stays a subdirectory), paths relative to it.
const DIFF = `git -C ${R} diff --relative`
// quotePath=false prints non-ASCII names as they are, not as quoted octal escapes.
// shortcut: git still quotes names containing `"`, tab or newline even with quotePath=false, so such files show as unexpected; switch to -z with NUL splitting if that ever matters.
const NAMES = (from, to) => `git -C ${R} -c core.quotePath=false diff --relative --no-renames --name-only ${from} ${to}`
// Whole repository, paths relative to the git root: catches changes outside a monorepo subdirectory.
const ROOT_NAMES = (from, to) => `git -C ${R} -c core.quotePath=false diff --no-renames --name-only ${from} ${to}`

const TREE = { type: 'string', pattern: '^[0-9a-f]{40,64}$' }
const STRINGS = { type: 'array', items: { type: 'string' } }
const ERROR = { type: 'string', description: 'set only when a command failed: its output, including any NOT_GIT line' }
const SPLIT = { type: 'object', required: ['prefix', 'realRepo', 'fallback', 'units'], properties: {
  baseTree: TREE, error: ERROR,
  prefix: { type: 'string', description: 'the text after prefix= (empty when the repository is the git root or the command failed)' },
  realRepo: { type: 'string', description: 'the text after real= (empty when the command failed)' },
  fallback: { type: 'boolean', description: 'true when the plan has no Units section and you returned the single unit U1' },
  units: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'goal', 'files', 'dependsOn'], properties: {
    id: { type: 'string' }, goal: { type: 'string' },
    files: { ...STRINGS, minItems: 1, description: 'repo-relative file or directory paths, no globs' },
    dependsOn: { ...STRINGS, description: 'ids of earlier units' } } } } } }
const UNIT_RESULT = { type: 'object', required: ['status', 'filesChanged', 'summary'], properties: {
  status: { type: 'string', enum: ['done', 'blocked'] }, filesChanged: STRINGS, summary: { type: 'string' },
  blocker: { type: 'string', description: 'when blocked: the file or problem that stopped the unit, and why' } } }
const SNAP = { type: 'object', properties: { tree: TREE, changedFiles: STRINGS, rootFiles: STRINGS, error: ERROR } }
const FINDINGS = { type: 'object', required: ['findings'], properties: {
  findings: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'title', 'detail'], properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: 'integer' },
    title: { type: 'string' }, detail: { type: 'string', description: 'what is wrong, why it matters, and the fix' },
    regressionOf: { type: 'string', description: 'id of the settled finding this one reopens' } } } },
  notRun: { ...STRINGS, description: 'verification steps with side effects that you listed instead of running' } } }
const FIX = { type: 'object', required: ['results', 'filesChanged'], properties: {
  results: { type: 'array', items: { type: 'object', required: ['id', 'status', 'note'], properties: {
    id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'declined'] },
    note: { type: 'string', description: 'what was changed, or why the finding is declined' } } } },
  filesChanged: STRINGS } }

const overlap = (x, y) => x === '' || y === '' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
const json = v => JSON.stringify(v, null, 2)
const planBlock = `The approved plan:\n<plan>\n${plan}\n</plan>`
const GIT_RULE = 'Use git only to read (status, diff, log, show); the index, HEAD, branches and stash stay as they are, and every change stays uncommitted. The orchestrator commits.'
const SEVERITY = 'Severity: blocker = the change is broken or unsafe to merge; major = must be fixed before merge; minor = worth fixing, and safe to ship without another review.'
const LEFT_OUT = `The diff covers only files under ${repo}, with paths relative to it. It is built from snapshots of the working tree, so it leaves out changes inside submodules and in ignored or generated files. When the change touches those, read them in the live tree.`
const FAILED = 'When a command exits non-zero or prints NOT_GIT, stop running commands and put its output in error.'

// 1. Split
const given = a.baseTree
// Fails with BAD_BASE_TREE when the given id is not a tree in this repository's object store.
const BASE_CHECK = given ? ` && { git -C ${R} cat-file -e '${given}^{tree}' || { echo BAD_BASE_TREE; false; }; }` : ''
const split = await tryAgent([
  STAGE('Split'),
  `Repository: ${repo}`,
  `1. Run this command exactly as written, in one shell call. Return the text after prefix= as prefix (it may be empty) and the text after real= as realRepo.\n${INFO_CMD}${BASE_CHECK}`,
  given ? '' : `2. Run this command exactly as written, in one shell call. Its last output line is a tree id (40 or 64 hex characters); return it as baseTree.\n${SNAP_CMD}`,
  FAILED,
  `${given ? '2' : '3'}. Return the Units section at the end of the plan below as JSON, in plan order: each unit's id, goal, files and dependsOn, copied as the plan states them. Write each file as a path relative to the repository above; a directory stands for every file under it; no globs. When the plan has no Units section, return one unit "U1" whose goal is the whole plan and whose files are every file the plan creates or changes, and set fallback to true.`,
  `This stage reads only: run the command${given ? '' : 's'} above and nothing that edits a file.`,
  `Done when ${given ? '' : 'baseTree is the tree id the command printed, '}prefix and realRepo are what the command printed, and every unit of the plan is in the list.`,
  planBlock,
].filter(Boolean).join('\n\n'), { label: 'split', phase: 'Split', schema: SPLIT, effort: 'low' })
if (!split) return { status: 'split-failed' }
if (split.error) {
  log(`split: ${split.error.slice(0, 300)}`)
  if (/BAD_BASE_TREE/.test(split.error)) return { status: 'split-failed', detail: `args.baseTree ${given} is not a tree in this repository's object store: ${split.error}` }
  return { status: /NOT_GIT/.test(split.error) ? 'not-git' : 'split-failed', detail: split.error }
}
const baseTree = given || split.baseTree, units = split.units
if (!HEX.test(baseTree || '')) { log('split: no tree id returned'); return { status: 'split-failed', detail: 'no tree id returned' } }
if (split.fallback) log('split: the plan has no Units section; running it as one unit U1')

// Agents may report paths as absolute, via the symlink-resolved repo path, or relative to the git root of a monorepo.
// shortcut: stripping the prefix conflates <prefix><prefix>x with <prefix>x; resolve per source if a repo ever nests a dir named like itself.
const prefix = split.prefix.replace(/^\/+|\/+$/g, '')
const roots = [...new Set([repo, split.realRepo.replace(/(.)\/+$/, '$1')].filter(Boolean))]
const norm = p => {
  let s = String(p).trim()
  for (const r of roots) { if (s === r) s = ''; else if (s.startsWith(r + '/')) s = s.slice(r.length + 1) }
  s = s.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (prefix && s === prefix) s = ''; else if (prefix && s.startsWith(prefix + '/')) s = s.slice(prefix.length + 1)
  return s === '.' ? '' : s
}

// 2. Validate and order the units; a dependency may only point at an earlier unit, so no cycle is possible.
const ids = units.map(u => u.id), dup = ids.filter((id, i) => ids.indexOf(id) !== i)
if (dup.length) return { status: 'bad-units', detail: 'duplicate unit ids: ' + dup.join(', '), baseTree, units }
units.forEach(u => { u.files = u.files.map(norm) })
units.forEach((u, i) => {
  const earlier = units.slice(0, i)
  const dropped = u.dependsOn.filter(d => !earlier.some(e => e.id === d))
  if (dropped.length) log(`${u.id}: dropped deps on later or unknown units: ${dropped}`)
  u.dependsOn = earlier.filter(e => u.dependsOn.includes(e.id) || e.files.some(f => u.files.some(g => overlap(f, g)))).map(e => e.id)
})
log(units.map(u => `${u.id} <- [${u.dependsOn}]`).join('; '))
const unitFiles = units.flatMap(u => u.files)

// 3. Implement: each unit starts the moment its last dependency finishes.
const implPrompt = u => [
  STAGE('Implement'),
  `Repository: ${repo}. Your shell starts elsewhere; work in this directory.`,
  `Your unit: ${u.id}\nGoal: ${u.goal}\nYour files:\n${u.files.map(f => '- ' + (f || '(the whole repository)')).join('\n')}`,
  'Other units edit other files in this same working tree at the same time. Keep to your own files:',
  [
    '- Edit only the files listed above. When the goal needs a change to any other file, stop and return status "blocked" with blocker naming that file and why.',
    `- ${GIT_RULE}`,
    '- Run checks scoped to your files: their tests, and linters or type checks on those paths. The full suite runs in review; other units\' half-written files may break it now.',
  ].join('\n'),
  'Done when the unit\'s goal is met in your files, its scoped checks pass, and filesChanged lists every file you created, edited or deleted, relative to the repository above.',
  planBlock,
].join('\n\n')
const byId = new Map(units.map(u => [u.id, u])), runs = new Map()
const run = u => {
  if (!runs.has(u.id)) runs.set(u.id, (async () => {
    const deps = await Promise.all(u.dependsOn.map(d => run(byId.get(d))))
    if (deps.some(r => !r || r.status !== 'done')) { log(`${u.id}: skipped, a dependency failed`); return null }
    const r = await tryAgent(implPrompt(u), { label: 'implement:' + u.id, phase: 'Implement', schema: UNIT_RESULT })
    const extra = r ? r.filesChanged.map(norm).filter(f => !u.files.some(g => overlap(f, g))) : []
    if (extra.length) log(`${u.id}: changed files outside its list: ${extra.join(', ')}`)
    return r
  })())
  return runs.get(u.id)
}
const results = await Promise.all(units.map(run))
if (results.some(r => !r || r.status !== 'done'))
  return { status: 'implement-failed', baseTree, units: units.map((u, i) => ({ ...u, result: results[i] })),
    next: `Fix the blocker, then rerun with the same plan and repo plus baseTree: "${baseTree}", so review covers all work since this base.` }

// 4. Snapshot: the tree now, and every file changed since baseTree.
const snapPrompt = () => [
  STAGE('Snapshot'),
  `Run this command exactly as written, in one shell call. It records the working tree as a git tree id and leaves the index, HEAD and branches untouched. Its last output line is the tree id; return it as tree.\n${SNAP_CMD}`,
  `Then run \`${NAMES(baseTree, '<tree>')}\` with that tree id, and return every line it prints as changedFiles.`,
  prefix ? `Then run \`${ROOT_NAMES(baseTree, '<tree>')}\` with the same tree id, and return every line it prints as rootFiles.` : '',
  FAILED,
  `Run nothing else; this stage edits no file. Done when tree is the id the command printed and changedFiles${prefix ? ' and rootFiles hold every line of the second and third commands' : ' holds every line of the second command'}.`,
].filter(Boolean).join('\n\n')
const snapshot = async label => {
  const s = await tryAgent(snapPrompt(), { label, phase: 'Review', schema: SNAP, effort: 'low' })
  if (!s) return null
  if (s.error || !HEX.test(s.tree || '') || !Array.isArray(s.changedFiles) || (prefix && !Array.isArray(s.rootFiles))) {
    log(`${label}: ${s.error ? s.error.slice(0, 300) : 'no tree id, changedFiles or rootFiles returned'}`)
    return null
  }
  return s
}
let unexpectedFiles = [], outsideScope = []
const checkUnexpected = s => {
  const next = s.changedFiles.map(norm).filter(c => !unitFiles.some(f => overlap(c, f)))
  const fresh = next.filter(f => !unexpectedFiles.includes(f))
  if (fresh.length) log(`changed files outside every unit: ${fresh.join(', ')}`)
  unexpectedFiles = next
  // Paths relative to the git root; the --relative diffs never show these.
  const out = prefix ? s.rootFiles.filter(f => !f.startsWith(prefix + '/')) : []
  const freshOut = out.filter(f => !outsideScope.includes(f))
  if (freshOut.length) log(`changed files outside the repository scope ${repo}: ${freshOut.join(', ')}`)
  outsideScope = out
}
const s1 = await snapshot('snapshot:1')
if (!s1) return { status: 'snapshot-failed', baseTree, units }
checkUnexpected(s1)

// 5. Review loop: a blocker or major stays open until the fixer marks it fixed.
let from = baseTree, to = s1.tree
const settled = [], rounds = []
const key = f => `${f.file}\n${f.title}`.toLowerCase()
// A finding's family: settled entries linked to it by file+title or by regressionOf, transitively.
// Returns how many distinct rounds fixed a blocker/major of that family (R<round>P1 and R<round>B1 are one fix).
const fixRounds = f => {
  const fam = new Set(), keys = new Set([key(f)]), ids = new Set(), links = new Set([f.regressionOf])
  for (let grew = true; grew;) {
    grew = false
    for (const s of settled) if (!fam.has(s) && (keys.has(key(s)) || links.has(s.id) || ids.has(s.regressionOf))) {
      fam.add(s); keys.add(key(s)); ids.add(s.id); links.add(s.regressionOf); grew = true
    }
  }
  return new Set([...fam].filter(s => s.status === 'fixed' && s.severity !== 'minor').map(s => (/^R(\d+)/.exec(s.id) || [])[1])).size
}
const openOf = list => list.filter(f => f.severity !== 'minor' && f.status !== 'fixed')
const notRunOf = extra => [...new Set([...rounds.flatMap(r => r.notRun), ...extra])]
const finish = extra => { const left = openOf(settled); return { status: left.length ? 'escalate' : 'done', open: left, baseTree, finalTree: to, unexpectedFiles, outsideScope, units, rounds, settled, notRun: notRunOf([]), ...extra } }

const diffBlock = round => [
  `Repository: ${repo}. Read the change with:\n${DIFF} ${from} ${to}`,
  round > 1 ? `This is review round ${round}: that diff is the delta since the last review, the fixer's work. The whole change so far is \`${DIFF} ${baseTree} ${to}\`.` : '',
  LEFT_OUT,
  outsideScope.length ? `Changed outside the repository scope (paths relative to the git root; the diff above leaves them out); read them, and name any finding on one of them by its absolute path:\n${outsideScope.map(f => '- ' + f).join('\n')}` : '',
  'Read the live tree and run tests, builds and linters as you need; leave every file as it is.',
].filter(Boolean).join('\n\n')
const settledBlock = list => `Findings settled in earlier rounds, with what the fixer did:\n${json(list)}\n\nReport only new problems and regressions. A settled finding stays settled; one the delta broke again, or one marked fixed that is still wrong, is reported again with regressionOf set to its id.`
const planCheckPrompt = round => [
  STAGE('Implementation review, plan check'),
  diffBlock(round),
  `Check the change against the plan below:\n- every step and unit done as the plan says, in the files it names\n- nothing added that the plan does not ask for\n- the plan's verification: run each check that changes nothing (tests, builds, linters, dry runs) and report each failure. List each step with side effects (apply, install, migration, deploy, push) in notRun instead of running it.\n- files changed outside every unit's file list: ${unexpectedFiles.length ? unexpectedFiles.join(', ') : 'none'}. Judge whether each belongs to the change.`,
  SEVERITY,
  'Keep each finding\'s title free of plan references (unit ids, step numbers, plan wording): titles reach a reviewer who never sees the plan.',
  round > 1 ? settledBlock(settled) : '',
  'Done when every plan step is checked against the change and each finding names its file and carries a fix-ready detail. Return an empty findings list when the change matches the plan.',
  planBlock,
].filter(Boolean).join('\n\n')
const blindPrompt = round => [
  STAGE('Implementation review, blind'),
  diffBlock(round),
  [
    'Review the change on its own terms, from the code and the repository alone:',
    '- correctness: logic, edge cases, error handling',
    '- every environment and project the code runs in: each OS, shell and runtime version, each deployment, and every caller or consumer of what changed',
    '- partial failure: one replica, consumer or tenant failing while the rest succeed; a step that dies halfway',
    '- noise: alerts, logs and retries the change adds or multiplies',
    '- each file\'s own conventions: naming, structure, error style and the patterns already in it',
  ].join('\n'),
  SEVERITY,
  round > 1 ? settledBlock(settled.map(f => ({ id: f.id, file: f.file, line: f.line, title: f.title, status: f.status }))) : '',
  'Done when every changed file is read around each hunk and each finding names its file and carries a fix-ready detail. Return an empty findings list when the change is sound.',
].filter(Boolean).join('\n\n')
const fixPrompt = (found, round) => [
  STAGE('Implement, fix round'),
  `Repository: ${repo}. Your shell starts elsewhere; work in this directory. This is fix round ${round}.`,
  `Review findings:\n${json(found)}`,
  'For each finding, fix it in the working tree, or decline it with a reason when it is wrong or outside the plan. Return one result per finding id.',
  `Edit only the units' files below and the files named in the findings you fix. Never revert, delete or rewrite any other file. A finding about a file changed outside the units' files is declined, with a note for the orchestrator, unless the plan clearly owns that file.\nUnits' files:\n${unitFiles.map(f => '- ' + (f || '(the whole repository)')).join('\n')}`,
  GIT_RULE,
  'Run the checks for every file you touch.',
  'Done when every finding id has a result, each fixed one is fixed in the tree with its checks passing, and filesChanged lists every file you touched.',
  planBlock,
].join('\n\n')

for (let round = 1; ; round++) {
  const [p, b] = await parallel([
    () => tryAgent(planCheckPrompt(round), { label: `review:plan:${round}`, phase: 'Review', schema: FINDINGS, effort: 'high' }),
    () => tryAgent(blindPrompt(round), { label: `review:blind:${round}`, phase: 'Review', schema: FINDINGS, effort: 'high' }),
  ])
  if (!p || !b) return finish({ status: 'review-failed', round, survivingFindings: (p || b || { findings: [] }).findings,
    notRun: notRunOf((p && p.notRun) || []) })
  const found = [...p.findings.map((f, i) => ({ id: `R${round}P${i + 1}`, ...f })), ...b.findings.map((f, i) => ({ id: `R${round}B${i + 1}`, ...f }))]
  rounds.push({ round, from, to, findings: found, notRun: p.notRun || [] })
  const open = found.filter(f => f.severity !== 'minor')
  if (!found.length) return finish()
  // No round cap; stop when a blocker/major already fixed (as blocker/major) in two rounds comes back again.
  const back = open.filter(f => fixRounds(f) >= 2)
  if (back.length) return { ...finish({ note: 'finding keeps returning' }), status: 'escalate', open: [...open, ...openOf(settled)] }
  const fix = await tryAgent(fixPrompt(found, round), { label: `fix:${round}`, phase: 'Fix', schema: FIX })
  if (!fix) return { ...finish(), status: 'fix-failed', open: [...open, ...openOf(settled)] }
  const merged = found.map(f => ({ ...f, ...(fix.results.find(r => r.id === f.id) || { status: 'unreported', note: '' }) }))
  settled.push(...merged)
  if (!open.length) return finish() // minor fixes ship without another review; finalTree is the last reviewed tree
  const s = await snapshot(`snapshot:${round + 1}`)
  if (!s) return { ...finish(), status: 'snapshot-failed' }
  checkUnexpected(s)
  if (s.tree === to) {
    const claimed = merged.filter(f => f.severity !== 'minor' && f.status === 'fixed')
    return { ...finish({ note: 'the fixer changed nothing' }), status: 'escalate', open: [...openOf(settled), ...claimed] }
  }
  from = to; to = s.tree
}
