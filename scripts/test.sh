#!/usr/bin/env bash
# Runs agent-skills-progress against sample projects under Node and checks what it prints.
set -u
here=$(cd "$(dirname "$0")" && pwd)
script="$here/agent-skills-progress.mjs"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0

check() { # name expected-substring command...
  local name=$1 want=$2; shift 2
  local out
  out=$("$@" 2>&1)
  if [[ $out == *"$want"* ]]; then echo "ok   $name"; else echo "FAIL $name: want '$want' in:"; echo "$out" | sed 's/^/       /'; fail=1; fi
}

mkdir -p "$tmp/empty"
check empty 'No SPEC.md, tasks/plan.md or tasks/todo.md here.' node "$script" "$tmp/empty" --no-color

mkdir -p "$tmp/build/tasks"
printf -- '---\nstatus: draft\n---\n# Spec: Keys\n## Objective\nx\n' > "$tmp/build/SPEC.md"
cat > "$tmp/build/tasks/todo.md" <<'MD'
## Task 1: Scaffold
- [x] builds
**Dependencies:** None
## Task 2: Prisma schema for keys
- [x] table
- [ ] migration
**Dependencies:** Task 1
## Task 3: Rate limit
- [ ] 429 after 60 req/min
**Dependencies:** Task 2
MD
check brief '♦spec ✓plan ●build 1/3 ○review ○ship · T2 Prisma schema for keys' node "$script" "$tmp/build" --brief --no-color
check full-header '│ agent-skills · Keys' node "$script" "$tmp/build" --no-color --no-git --width 70
check full-next '☐ migration' node "$script" "$tmp/build" --no-color --no-git
check no-git-history 'history from today: not a git repository' node "$script" "$tmp/build" --no-color
check json '"current": "T2"' node "$script" "$tmp/build" --json
check json-schema '"schema": 1' node "$script" "$tmp/build" --json
check colour $'\033[32m✓\033[0m T1' node "$script" "$tmp/build" --color --no-git
check no-color-env 'T1 Scaffold' env NO_COLOR=1 node "$script" "$tmp/build" --no-git
check timeline-tree '├─ ✓ T1 Scaffold                ▬▬▬ done' node "$script" "$tmp/build" --timeline --no-color --no-git
check bad-option 'unknown option --nope' node "$script" --nope
mkdir -p "$tmp/build/specs"; printf '# Spec: Auth\n## Objective\nx\n' > "$tmp/build/specs/auth.md"
check module-spec 'Spec · specs/auth.md' node "$script" "$tmp/build" --spec auth --no-color --no-git

out=$(node "$script" "$tmp/build" --no-color 2>&1)
if [[ $out == *Warning* ]]; then echo "FAIL no-warnings: Node printed a warning"; fail=1; else echo "ok   no-warnings"; fi
# The dashboard page (K6): written where asked, its inline script valid JavaScript.
check dashboard-default 'Wrote' node "$script" "$tmp/build" --dashboard --no-git
if [[ -s "$tmp/build/tasks/progress-dashboard.html" ]]; then echo "ok   dashboard-file"; else echo "FAIL dashboard-file: tasks/progress-dashboard.html not written"; fail=1; fi
check dashboard-out 'custom.html' node "$script" "$tmp/build" --dashboard "$tmp/custom.html" --no-git
check dashboard-empty 'Wrote' node "$script" "$tmp/empty" --dashboard "$tmp/empty.html"
if grep -q 'No task list yet' "$tmp/empty.html"; then echo "ok   dashboard-empty-says-why"; else echo "FAIL dashboard-empty-says-why"; fail=1; fi
node -e 'const h=require("fs").readFileSync(process.argv[1],"utf8");const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];if(m.length!==1)process.exit(2);require("fs").writeFileSync(process.argv[2],m[0][1])' "$tmp/build/tasks/progress-dashboard.html" "$tmp/dash.js"
if node --check "$tmp/dash.js" 2>/dev/null; then echo "ok   dashboard-script-parses"; else echo "FAIL dashboard-script-parses"; fail=1; fi

# The chart bundle (K4): generated, valid JavaScript, inside its size limit.
bundle="$here/../packages/core/dashboard/charts-bundle.ts"
if head -1 "$bundle" | grep -q '@generated'; then echo "ok   charts-bundle-generated"; else echo "FAIL charts-bundle-generated: $bundle is not the build's output"; fail=1; fi
node --no-warnings --experimental-strip-types -e 'import(process.argv[1]).then(m => require("fs").writeFileSync(process.argv[2], m.CHARTS_JS))' "$bundle" "$tmp/charts.js"
if node --check "$tmp/charts.js" 2>/dev/null; then echo "ok   charts-bundle-parses"; else echo "FAIL charts-bundle-parses"; fail=1; fi
size=$(wc -c < "$tmp/charts.js" | tr -d ' ')
if (( size < 600 * 1024 )); then echo "ok   charts-bundle-size ($((size / 1024)) KB of 600)"; else echo "FAIL charts-bundle-size: $((size / 1024)) KB, over 600"; fail=1; fi

# Modules (format-v2 T10): the capability map with an archived plan.
mkdir -p "$tmp/mods/tasks/archive/2026-09-26-core"
printf -- '---\nstatus: approved\n---\n# Capability Map: keys\n\n| Module id | Responsibility | Depends on |\n|---|---|---|\n| core | Library | — |\n| api | The API | core |\n' > "$tmp/mods/SPEC.md"
printf -- '---\nplan: core\ncreated: 2026-09-20\n---\n## Task 1: Lib\n**Status:** done · started 2026-09-20 · done 2026-09-25\n- [x] lib\n' > "$tmp/mods/tasks/archive/2026-09-26-core/todo.md"
check modules-cli '✓ core   done · 1/1' node "$script" "$tmp/mods" --modules --no-color --no-git
check modules-json '"state": "not started"' node "$script" "$tmp/mods" --json --no-git
check modules-one '✓ T1 Lib' node "$script" "$tmp/mods" --modules core --no-color --no-git

# The board across branches (team-view T3): a real repository with two branches, read without fetching.
repo="$tmp/branches"; mkdir -p "$repo"
g() { git -C "$repo" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
g init -b main; echo x > "$repo/README.md"; g add .; g commit -m init; g branch docs
mkdir -p "$repo/tasks"
printf -- '## Task 1: Scaffold\n**Status:** done · started 2026-10-01 · done 2026-10-02\n- [x] builds\n\n## Task 2: Rate limit\n- [ ] 429\n' > "$repo/tasks/todo.md"
g add .; g commit -m plan; g checkout -b feat/rate-limit
printf -- '## Task 1: Scaffold\n**Status:** done · started 2026-10-01 · done 2026-10-02\n- [x] builds\n\n## Task 2: Rate limit\n**Status:** in progress · @bob · started 2026-10-10\n- [ ] 429\n' > "$repo/tasks/todo.md"
g commit -am 'T2 started'; g checkout main
check branches-head 'Board across branches · main + 1 ref · never fetched' node "$script" "$repo" --branches --no-color
check branches-furthest '● T2 Rate limit · in progress on feat/rate-limit @bob' node "$script" "$repo" --branches --no-color
check branches-missing 'No tasks/todo.md on: docs.' node "$script" "$repo" --branches --no-color
touch "$repo/.git/FETCH_HEAD"
check branches-fetched 'fetched 0m ago' node "$script" "$repo" --branches --no-color
check branches-json '"ref": "feat/rate-limit"' node "$script" "$repo" --json
check branches-no-repo 'Not a git repository' node "$script" "$tmp/build" --branches
if [[ -z $(git -C "$repo" status --porcelain) && $(git -C "$repo" rev-parse --abbrev-ref HEAD) == main ]]; then echo "ok   branches-untouched"; else echo "FAIL branches-untouched: the repository changed"; fail=1; fi
# Collisions (team-view T4): T2 started here too, by someone else, collides with feat/rate-limit.
check collisions-none '"collisions": []' node "$script" "$repo" --json
printf -- '## Task 1: Scaffold\n**Status:** done · started 2026-10-01 · done 2026-10-02\n- [x] builds\n\n## Task 2: Rate limit\n**Status:** in progress · @amila · started 2026-10-10\n- [ ] 429\n' > "$repo/tasks/todo.md"
check collisions-json '"under way"' node "$script" "$repo" --json
check collisions-ref '"ref": "feat/rate-limit"' node "$script" "$repo" --json
# The dashboard's Board across branches (team-view T5): the switch, the furthest states and the collision.
check dashboard-branches 'Wrote' node "$script" "$repo" --dashboard "$tmp/across.html"
if grep -q 'id="board-branches"' "$tmp/across.html" && grep -q 'T2 is also in progress on feat/rate-limit by @bob' "$tmp/across.html"; then echo "ok   dashboard-branches-board"; else echo "FAIL dashboard-branches-board"; fail=1; fi
# The page's script against a stand-in DOM: #board?branches=all&owner=… keeps both, and each control writes both back.
cat > "$tmp/board-script.js" <<'JS'
const html = require('fs').readFileSync(process.argv[2], 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const board = html.match(/id="view-board"[\s\S]*?<!-- \/view-board -->/)[0]
const attr = (tag, k) => (tag.match(new RegExp(` data-${k}="([^"]*)"`)) || [])[1]
const cards = [...board.matchAll(/<li [^>]*data-state="[^"]*"[^>]*>/g)].map(m => ({ hidden: false, dataset: { task: attr(m[0], 'task'), phase: attr(m[0], 'phase'), state: attr(m[0], 'state'), owner: attr(m[0], 'owner') } }))
const cls = new Set(), on = {}
const control = () => ({ value: '', checked: false, disabled: false, ls: {}, addEventListener(t, f) { this.ls[t] = f } })
const ctl = Object.fromEntries(['board-phase', 'board-state', 'board-owner', 'board-group', 'board-branches'].map(id => [id, html.includes(`id="${id}"`) ? control() : null]))
const tabs = [...html.matchAll(/role="tab" id="tab-(\w+)"/g)].map(m => ({ getAttribute: () => '#' + m[1], setAttribute() {}, addEventListener() {} }))
const views = Object.fromEntries(tabs.map(t => [t.getAttribute().slice(1), { hidden: false, querySelectorAll: q => (q === '.col' ? [] : cards) }]))
const document = {
  body: { dataset: { view: 'overview' }, classList: { add: c => cls.add(c), toggle: (c, v) => (v ? cls.add(c) : cls.delete(c)) } },
  getElementById: id => (id in ctl ? ctl[id] : views[id.replace(/^view-/, '')]),
  querySelectorAll: q => (q === '[role=tab]' ? tabs : []),
}
// As a browser does: the hash reads back with its #, however it was set.
let h = '#board?branches=all&owner=amila'
const location = { get hash() { return h }, set hash(v) { h = v.replace(/^#?/, '#') } }
require('vm').runInNewContext(script, { document, location, URLSearchParams, addEventListener: (t, f) => (on[t] = f) })
const fail = m => { console.log(m); process.exit(1) }
if (!cls.has('allb') || ctl['board-branches'].value !== 'all' || ctl['board-owner'].value !== 'amila') fail('the hash did not set both')
if (cards.some(c => c.hidden !== (c.dataset.owner !== 'amila'))) fail('the person filter did not apply with all branches')
ctl['board-owner'].value = ''; ctl['board-owner'].ls.change()
if (location.hash !== '#board?branches=all') fail('the person filter dropped the switch: ' + location.hash)
ctl['board-owner'].value = 'amila'; ctl['board-branches'].value = ''; ctl['board-branches'].ls.change()
if (location.hash !== '#board?owner=amila') fail('the switch dropped the person filter: ' + location.hash)
on.hashchange()
if (cls.has('allb') || ctl['board-owner'].value !== 'amila') fail('this branch did not come back with the person filter')
console.log('both kept')
JS
if out=$(node "$tmp/board-script.js" "$tmp/across.html" 2>&1); then echo "ok   dashboard-branches-script ($out)"; else echo "FAIL dashboard-branches-script: $out"; fail=1; fi

# The shared core imports only itself (J1).
if out=$(node "$here/purity.mjs" 2>&1); then echo "ok   core-purity ($out)"; else echo "FAIL core-purity:"; echo "$out" | sed 's/^/       /'; fail=1; fi

# The checker itself catches an import that leaves the library.
mkdir -p "$tmp/impure"; printf "import { x } from '../elsewhere'\nexport const y = x\n" > "$tmp/impure/a.ts"
if node "$here/purity.mjs" "$tmp/impure" >/dev/null 2>&1; then echo "FAIL core-purity-catches: an outside import passed"; fail=1; else echo "ok   core-purity-catches"; fi
mkdir -p "$tmp/api"; printf "// stands in for \$.process.run\nexport const run = (\$: any) => \$.process.run\n" > "$tmp/api/a.ts"
out=$(node "$here/purity.mjs" "$tmp/api" 2>&1)
if [[ $out == *"a.ts: uses the Claude Code API"* && $out == "1 offence"* || $out == *$'\n1 offence'* ]]; then echo "ok   core-purity-api (code caught, comment ignored)"; else echo "FAIL core-purity-api:"; echo "$out" | sed 's/^/       /'; fail=1; fi
exit $fail
