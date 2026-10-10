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

# The shared core imports only itself (J1).
if out=$(node "$here/purity.mjs" 2>&1); then echo "ok   core-purity ($out)"; else echo "FAIL core-purity:"; echo "$out" | sed 's/^/       /'; fail=1; fi

# The checker itself catches an import that leaves the library.
mkdir -p "$tmp/impure"; printf "import { x } from '../elsewhere'\nexport const y = x\n" > "$tmp/impure/a.ts"
if node "$here/purity.mjs" "$tmp/impure" >/dev/null 2>&1; then echo "FAIL core-purity-catches: an outside import passed"; fail=1; else echo "ok   core-purity-catches"; fi
mkdir -p "$tmp/api"; printf "// stands in for \$.process.run\nexport const run = (\$: any) => \$.process.run\n" > "$tmp/api/a.ts"
out=$(node "$here/purity.mjs" "$tmp/api" 2>&1)
if [[ $out == *"a.ts: uses the Claude Code API"* && $out == "1 offence"* || $out == *$'\n1 offence'* ]]; then echo "ok   core-purity-api (code caught, comment ignored)"; else echo "FAIL core-purity-api:"; echo "$out" | sed 's/^/       /'; fail=1; fi
exit $fail
