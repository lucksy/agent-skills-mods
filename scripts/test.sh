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
# ceremonies T1: a sized task has its size in --json; an unsized one has no size key.
mkdir -p "$tmp/sized/tasks"; printf -- '## Task 1: Scaffold\n**Status:** todo\n**Size:** L\n- [ ] builds\n' > "$tmp/sized/tasks/todo.md"
check json-size '"size": "L"' node "$script" "$tmp/sized" --json --no-git
# ceremonies T3: tasks/backlog.md in --json when there is one, and no backlog key without it.
printf -- '# Backlog\n\n## B1: Quotas\n**Size:** M\n- [ ] per tenant\n' > "$tmp/sized/tasks/backlog.md"
check json-backlog '"file": "tasks/backlog.md"' node "$script" "$tmp/sized" --json --no-git
if node "$script" "$tmp/build" --json --no-git | grep -q '"backlog"'; then echo "FAIL json-no-backlog: a project with no backlog has a backlog key"; fail=1; else echo "ok   json-no-backlog"; fi
if node "$script" "$tmp/build" --json --no-git | grep -q '"size"'; then echo "FAIL json-no-size: an unsized task has a size key"; fail=1; else echo "ok   json-no-size"; fi
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

# The live server (team-view T10): a random port, the token, a write on disk, a `changed` event.
mkdir -p "$tmp/live/tasks"; cp "$tmp/build/tasks/todo.md" "$tmp/live/tasks/todo.md"
node "$script" "$tmp/live" --serve --port 0 --no-open --no-git > "$tmp/serve.out" 2>&1 &
serve_pid=$!
url=''
for _ in $(seq 1 100); do url=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[0-9a-f]*' "$tmp/serve.out" | head -1); [[ -n $url ]] && break; sleep 0.1; done
if [[ -n $url ]]; then
  echo "ok   serve-url"
  base=${url%%/?token=*}; token=${url##*token=}
  code=$(curl -s -o /dev/null -w '%{http_code}' "$base/")
  if [[ $code == 401 ]]; then echo "ok   serve-no-token-401"; else echo "FAIL serve-no-token-401: got $code"; fail=1; fi
  head=$(curl -s -D - -o "$tmp/live.html" "$url")
  rev=$(printf '%s' "$head" | tr -d '\r' | sed -n 's/^x-agent-skills-rev: //Ip')
  if [[ -n $rev ]] && grep -q '<html' "$tmp/live.html"; then echo "ok   serve-get-page"; else echo "FAIL serve-get-page"; fail=1; fi
  if printf '%s' "$head" | grep -qi '^access-control-'; then echo "FAIL serve-no-cors"; fail=1; else echo "ok   serve-no-cors"; fi
  # The live page (T11): its write buttons, the rev they post with, and a script of its own that parses.
  if grep -q 'data-act="start" data-args="{&quot;id&quot;:&quot;T3&quot;}"' "$tmp/live.html" && grep -q "data-rev=\"$rev\"" "$tmp/live.html"; then echo "ok   serve-page-buttons"; else echo "FAIL serve-page-buttons"; fail=1; fi
  node -e 'const h=require("fs").readFileSync(process.argv[1],"utf8");const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];if(m.length!==2)process.exit(2);require("fs").writeFileSync(process.argv[2],m[1][1])' "$tmp/live.html" "$tmp/live.js"
  if node --check "$tmp/live.js" 2>/dev/null && [[ $(wc -c < "$tmp/live.js") -lt 4096 ]]; then echo "ok   serve-live-script"; else echo "FAIL serve-live-script"; fail=1; fi
  curl -s -N --max-time 8 "$base/events?token=$token" > "$tmp/events.out" &
  events_pid=$!
  sleep 0.5
  out=$(curl -s -X POST -H "X-Agent-Skills-Token: $token" -H "Origin: $base" -H 'Content-Type: application/json' \
    --data "{\"action\":\"tick\",\"args\":{\"id\":\"T3\",\"index\":0},\"rev\":\"$rev\"}" "$base/action")
  if [[ $out == *'T3 ticked: 429 after 60 req/min'* ]]; then echo "ok   serve-post-action"; else echo "FAIL serve-post-action: $out"; fail=1; fi
  if grep -q -- '- \[x\] 429 after 60 req/min' "$tmp/live/tasks/todo.md"; then echo "ok   serve-wrote-file"; else echo "FAIL serve-wrote-file"; fail=1; fi
  # A live write changes only what its action owns: no created: field, no Status line on another task.
  if ! grep -q '^created:' "$tmp/live/tasks/todo.md" && [[ $(grep -c '^\*\*Status:\*\*' "$tmp/live/tasks/todo.md") == 1 ]]; then echo "ok   serve-owned-lines-only"; else echo "FAIL serve-owned-lines-only:"; sed 's/^/       /' "$tmp/live/tasks/todo.md"; fail=1; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Agent-Skills-Token: $token" -H "Origin: $base" \
    --data "{\"action\":\"tick\",\"args\":{\"id\":\"T3\",\"index\":0},\"rev\":\"$rev\"}" "$base/action")
  if [[ $code == 409 ]]; then echo "ok   serve-stale-409"; else echo "FAIL serve-stale-409: got $code"; fail=1; fi
  # ceremonies T4: POST pull moves a backlog item into the task list; both files change on disk.
  printf -- '# Backlog\n\n## B1: Docs\n- [ ] docs\n' > "$tmp/live/tasks/backlog.md"
  rev=$(curl -s -D - -o /dev/null "$url" | tr -d '\r' | sed -n 's/^x-agent-skills-rev: //Ip')
  out=$(curl -s -X POST -H "X-Agent-Skills-Token: $token" -H "Origin: $base" -H 'Content-Type: application/json' \
    --data "{\"action\":\"pull\",\"args\":{\"id\":\"B1\"},\"rev\":\"$rev\"}" "$base/action")
  if [[ $out == *'B1 Docs is T4 in tasks/todo.md now'* ]] && grep -q '^## Task 4: Docs' "$tmp/live/tasks/todo.md" && ! grep -q 'B1' "$tmp/live/tasks/backlog.md"; then echo "ok   serve-pull-both-files"; else echo "FAIL serve-pull-both-files: $out"; fail=1; fi
  for _ in $(seq 1 40); do grep -q 'event: changed' "$tmp/events.out" && break; sleep 0.1; done
  if grep -q 'event: changed' "$tmp/events.out"; then echo "ok   serve-changed-event"; else echo "FAIL serve-changed-event:"; sed 's/^/       /' "$tmp/events.out"; fail=1; fi
  kill "$events_pid" 2>/dev/null; wait "$events_pid" 2>/dev/null
  if lsof -nP -a -p "$serve_pid" -iTCP -sTCP:LISTEN 2>/dev/null | grep -q '127.0.0.1:'; then echo "ok   serve-loopback-only"; elif ! command -v lsof >/dev/null; then echo "ok   serve-loopback-only (no lsof; skipped)"; else echo "FAIL serve-loopback-only:"; lsof -nP -a -p "$serve_pid" -iTCP -sTCP:LISTEN | sed 's/^/       /'; fail=1; fi
else
  echo "FAIL serve-url:"; sed 's/^/       /' "$tmp/serve.out"; fail=1
fi
kill "$serve_pid" 2>/dev/null; wait "$serve_pid" 2>/dev/null
check serve-bad-port '--port takes a number' node "$script" "$tmp/live" --serve --port nope

# The merge driver (team-view T8): a real `git merge` in a throwaway repo, never this repo's config.
repo="$tmp/merge"; mkdir -p "$repo/tasks"
g() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$repo" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }
g init -q -b main
g config merge.agent-skills.name 'agent-skills task-aware merge'
g config merge.agent-skills.driver "node '$script' --merge %O %A %B %P"
printf 'tasks/todo.md   merge=agent-skills\ntasks/plan.md   merge=agent-skills\nSPEC*.md        merge=agent-skills\nspecs/*.md      merge=agent-skills\n' > "$repo/.gitattributes"
cat > "$repo/tasks/todo.md" <<'MD'
# Tasks: keys

## Task 1: Scaffold
**Status:** in progress · started 2026-10-02

- [ ] Builds
- [ ] Lints

**Dependencies:** None

## Task 2: Schema
**Status:** todo

- [ ] Table

**Dependencies:** T1

## Task 3: Rate limit
**Status:** todo

- [ ] 429 after 60 req/min

**Dependencies:** T2
MD
g add -A; g commit -qm base
# Both sides tick a box in T1 (neighbouring lines: a line merge conflicts) and move a different task.
g checkout -qb ann
sed -i.bak -e 's/- \[ \] Builds/- [x] Builds/' -e '/## Task 2/{n;s/.*/**Status:** in progress · started 2026-10-10/;}' "$repo/tasks/todo.md"; rm -f "$repo/tasks/todo.md.bak"
g commit -qam ann
g checkout -q main; g checkout -qb bob
sed -i.bak -e 's/- \[ \] Lints/- [x] Lints/' -e '/## Task 3/{n;s/.*/**Status:** blocked · started 2026-10-10/;}' "$repo/tasks/todo.md"; rm -f "$repo/tasks/todo.md.bak"
g commit -qam bob
g checkout -q ann
if out=$(g merge -q --no-edit bob 2>&1) && ! grep -q '^<<<<<<<\|^>>>>>>>' "$repo/tasks/todo.md"; then echo "ok   merge-driver-clean"; else echo "FAIL merge-driver-clean:"; echo "$out" | sed 's/^/       /'; sed 's/^/       /' "$repo/tasks/todo.md"; fail=1; fi
merged=$(cat "$repo/tasks/todo.md")
if [[ $merged == *'- [x] Builds'*'- [x] Lints'* && $merged == *$'## Task 2: Schema\n**Status:** in progress · started 2026-10-10'* && $merged == *$'## Task 3: Rate limit\n**Status:** blocked · started 2026-10-10'* ]]; then echo "ok   merge-driver-both-sides-kept"; else echo "FAIL merge-driver-both-sides-kept:"; echo "$merged" | sed 's/^/       /'; fail=1; fi
# A delete on one side, an edit on the other: markers around that task only, and git reports the conflict.
g checkout -qb del
awk '/^## Task 3/{skip=1} !skip' "$repo/tasks/todo.md" > "$repo/todo.tmp" && mv "$repo/todo.tmp" "$repo/tasks/todo.md"
g commit -qam 'drop T3'
g checkout -q ann; g checkout -qb edit
sed -i.bak 's/- \[ \] 429 after 60 req\/min/- [x] 429 after 60 req\/min/' "$repo/tasks/todo.md"; rm -f "$repo/tasks/todo.md.bak"
g commit -qam 'tick T3'
g checkout -q del
out=$(g merge --no-edit edit 2>&1); code=$?
if (( code != 0 )) && [[ $(g diff --name-only --diff-filter=U) == tasks/todo.md ]]; then echo "ok   merge-driver-conflict-reported"; else echo "FAIL merge-driver-conflict-reported (exit $code):"; echo "$out" | sed 's/^/       /'; fail=1; fi
if [[ $out == *'T3: deleted in ours, changed in theirs'* ]]; then echo "ok   merge-driver-says-which-task"; else echo "FAIL merge-driver-says-which-task:"; echo "$out" | sed 's/^/       /'; fail=1; fi
inside=$(awk '/^<<<<<<< /{m=1} m{print} /^>>>>>>> /{m=0}' "$repo/tasks/todo.md")
outside=$(awk '/^<<<<<<< /{m=1} !m{print} /^>>>>>>> /{m=0}' "$repo/tasks/todo.md")
if [[ $(grep -c '^<<<<<<< ' "$repo/tasks/todo.md") == 1 && $inside == *'## Task 3: Rate limit'*'- [x] 429 after 60 req/min'* && $inside != *'Task 1'* && $inside != *'Task 2'* && $outside == *'- [x] Builds'*'## Task 2: Schema'* ]]; then echo "ok   merge-driver-markers-one-task"; else echo "FAIL merge-driver-markers-one-task:"; sed 's/^/       /' "$repo/tasks/todo.md"; fail=1; fi
# A task number taken on both sides: theirs is renumbered, its references with it, and git shows the report.
g merge --abort 2>/dev/null; g checkout -q ann
g checkout -qb add-a; printf '\n## Task 4: Key rotation\n**Status:** todo\n\n- [ ] Rotate\n\n**Dependencies:** T3\n' >> "$repo/tasks/todo.md"; g commit -qam 'T4 rotation'
g checkout -q ann; g checkout -qb add-b; printf '\n## Task 4: Usage metrics\n**Status:** todo\n\n- [ ] Count\n\n**Dependencies:** T1\n\n## Task 5: Metrics docs\n**Status:** todo\n\n- [ ] Docs\n\n**Dependencies:** T4\n' >> "$repo/tasks/todo.md"; g commit -qam 'T4 metrics, T5 docs'
g checkout -q add-a
out=$(g merge --no-edit add-b 2>&1); code=$?
merged=$(cat "$repo/tasks/todo.md")
if (( code == 0 )) && [[ $out == *'T4 (theirs) is now T6'* && $merged == *$'## Task 4: Key rotation'* && $merged == *$'## Task 6: Usage metrics'* && $merged == *$'## Task 5: Metrics docs\n**Status:** todo\n\n- [ ] Docs\n\n**Dependencies:** T6'* ]]; then echo "ok   merge-driver-renumbered"; else echo "FAIL merge-driver-renumbered (exit $code):"; echo "$out" | sed 's/^/       /'; echo "$merged" | sed 's/^/       /'; fail=1; fi
check merge-driver-usage '--merge takes <base> <ours> <theirs> <path>' node "$script" --merge a b
# ceremonies T4: backlog add on two branches merges item by item with distinct B ids, and a task
# number taken on both sides skips the backlog's Was: numbers.
repo="$tmp/merge-backlog"; mkdir -p "$repo/tasks"
gb() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$repo" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }
gb init -q -b main
gb config merge.agent-skills.name 'agent-skills task-aware merge'
gb config merge.agent-skills.driver "node '$script' --merge %O %A %B %P"
printf 'tasks/todo.md   merge=agent-skills\ntasks/backlog.md merge=agent-skills\n' > "$repo/.gitattributes"
printf -- '# Backlog\n\n## B1: Docs\n**Was:** T3 · deferred 2026-10-11\n- [ ] x\n' > "$repo/tasks/backlog.md"
printf -- '## Task 1: Scaffold\n- [ ] builds\n' > "$repo/tasks/todo.md"
gb add -A; gb commit -qm base
gb checkout -qb ann
printf '\n## B2: Quotas\n**Size:** L\n' >> "$repo/tasks/backlog.md"; printf '\n## Task 2: Keys\n- [ ] keys\n' >> "$repo/tasks/todo.md"; gb commit -qam ann
gb checkout -q main; gb checkout -qb bob
printf '\n## B2: Audit export\n' >> "$repo/tasks/backlog.md"; printf '\n## Task 2: Limits\n- [ ] limits\n' >> "$repo/tasks/todo.md"; gb commit -qam bob
gb checkout -q ann
out=$(gb merge --no-edit bob 2>&1); code=$?
backlog=$(cat "$repo/tasks/backlog.md")
if (( code == 0 )) && ! grep -q '^<<<<<<<' "$repo/tasks/backlog.md" && [[ $backlog == *$'## B2: Quotas\n**Size:** L\n\n## B3: Audit export'* && $out == *'B2 (theirs) is now B3'* ]]; then echo "ok   merge-driver-backlog"; else echo "FAIL merge-driver-backlog (exit $code):"; echo "$out" | sed 's/^/       /'; echo "$backlog" | sed 's/^/       /'; fail=1; fi
if [[ $out == *'T2 (theirs) is now T4'* ]] && grep -q '^## Task 4: Limits' "$repo/tasks/todo.md"; then echo "ok   merge-driver-skips-was-numbers"; else echo "FAIL merge-driver-skips-was-numbers:"; echo "$out" | sed 's/^/       /'; fail=1; fi
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
# The Team tab (team-view T6): a card per person the task lists name, the collision linked to its Board card.
if grep -q 'id="view-team"' "$tmp/across.html" && grep -q 'data-person="bob"' "$tmp/across.html" && grep -q '<p class="p-clash"><a href="#card-T2">T2</a>' "$tmp/across.html"; then echo "ok   dashboard-team-tab"; else echo "FAIL dashboard-team-tab"; fail=1; fi
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
# The live page has the Board across branches too: --serve reads the branches as --dashboard does.
node "$script" "$repo" --serve --port 0 --no-open > "$tmp/serve-b.out" 2>&1 &
serve_b=$!
url=''
for _ in $(seq 1 100); do url=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[0-9a-f]*' "$tmp/serve-b.out" | head -1); [[ -n $url ]] && break; sleep 0.1; done
if [[ -n $url ]] && curl -s "$url" | grep -q 'id="board-branches"'; then echo "ok   serve-branches-board"; else echo "FAIL serve-branches-board"; fail=1; fi
kill "$serve_b" 2>/dev/null; wait "$serve_b" 2>/dev/null
# Since you last looked (team-view T9): the first look stores a snapshot quietly in the git folder, the next lists what changed with who did it.
check since-first 'First look here: nothing to compare with yet' node "$script" "$repo" --since
if [[ -f $repo/.git/agent-skills/seen.json ]] && grep -q '"schema": 1' "$repo/.git/agent-skills/seen.json"; then echo "ok   since-stored-in-git-dir"; else echo "FAIL since-stored-in-git-dir"; fail=1; fi
printf -- '## Task 1: Scaffold\n**Status:** done · started 2026-10-01 · done 2026-10-02\n- [x] builds\n\n## Task 2: Rate limit\n**Status:** done · @amila · started 2026-10-10 · done 2026-10-11\n- [x] 429\n' > "$repo/tasks/todo.md"
check since-json '"text": "T2 done by @amila"' node "$script" "$repo" --json
check since-lists '), 1 change:'$'\n''- T2 done by @amila' node "$script" "$repo" --since
check since-nothing 'Nothing changed since you last looked' node "$script" "$repo" --since
echo '{"schema":1,"at":' > "$repo/.git/agent-skills/seen.json"
check since-corrupt 'First look here' node "$script" "$repo" --since
check since-no-repo 'Not a git repository' node "$script" "$tmp/build" --since
if [[ -z $(git -C "$repo" status --porcelain -- .git) && $(git -C "$repo" ls-files) != *seen.json* ]]; then echo "ok   since-never-committed"; else echo "FAIL since-never-committed"; fail=1; fi

# The team standup (ceremonies T10): two branches, two authors, commits naming tasks; read without fetching.
repo="$tmp/standup"; mkdir -p "$repo/tasks"; day=$(date -u +%F)
s() { git -C "$repo" -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
s init -b main
printf -- '# Team\n\n| Handle | Role | Email |\n|---|---|---|\n| @amila | eng | amila@example.com |\n| @bob | eng | bob@example.com |\n| @sara | design | sara@example.com |\n' > "$repo/tasks/team.md"
printf -- '---\nplan: gateway\n---\n## Task 1: Scaffold\n**Status:** in progress · @amila · started %s · step test\n- [x] builds\n- [ ] lints\n\n## Task 2: Rate limit\n**Status:** todo\n- [ ] 429\n' "$day" > "$repo/tasks/todo.md"
s add .; s -c user.name=Amila -c user.email=amila@example.com commit -m 'T1: scaffold'
s checkout -b feat/rate-limit
printf -- '---\nplan: gateway\n---\n## Task 1: Scaffold\n**Status:** in progress · @amila · started %s · step test\n- [x] builds\n- [ ] lints\n\n## Task 2: Rate limit\n**Status:** done · @bob · started %s · done %s\n- [x] 429\n' "$day" "$day" "$day" > "$repo/tasks/todo.md"
s -c user.name=Bob -c user.email=bob@example.com commit -am 'T2: rate limit'
s -c user.name=Bob -c user.email=bob@example.com commit --allow-empty -m 'IT1 not a task'
s checkout main
check standup-team-head 'Team standup · gateway · ' node "$script" "$repo" --standup-team
check standup-team-amila '@amila: done T1 (commits) · today T1 (test, 1 box left) · blocked —' node "$script" "$repo" --standup-team
check standup-team-other-branch '@bob: done T2 · today — · blocked —' node "$script" "$repo" --standup-team
check standup-team-nothing '@sara: nothing under way' node "$script" "$repo" --standup-team
check standup-team-no-git 'Unowned: nothing under way' node "$script" "$repo" --standup-team --no-git
if [[ -z $(git -C "$repo" status --porcelain) && $(git -C "$repo" rev-parse --abbrev-ref HEAD) == main ]]; then echo "ok   standup-team-untouched"; else echo "FAIL standup-team-untouched: the repository changed"; fail=1; fi

# The decisions inbox (ceremonies T11): what waits on you, on a handle or on anyone, and in --json.
check inbox-me 'Inbox · everything waiting (no tasks/team.md, so nothing is filtered) · 1 waiting' node "$script" "$tmp/build" --inbox --no-git
check inbox-spec '  ♦ approve SPEC.md' node "$script" "$tmp/build" --inbox all --no-git
check inbox-handle '✓ Nothing is waiting on @amila.' node "$script" "$repo" --inbox @amila
check inbox-nothing '✓ Nothing is waiting on you.' node "$script" "$tmp/empty" --inbox
check inbox-json '"text": "approve SPEC.md"' node "$script" "$tmp/build" --json --no-git
# The Inbox tab (ceremonies T13): #inbox?who=pm shows what names @pm or nobody, and the picker writes the hash back.
mkdir -p "$tmp/inbox/tasks"; cp "$tmp/build/SPEC.md" "$tmp/build/tasks/todo.md" "$tmp/inbox/" 2>/dev/null; mv "$tmp/inbox/todo.md" "$tmp/inbox/tasks/todo.md"
printf -- '---\napprovals: product, eng\n---\n# Team\n\n| Handle | Role | Email |\n|---|---|---|\n| @amila | eng | amila@example.com |\n| @pm | product | pm@example.com |\n' > "$tmp/inbox/tasks/team.md"
printf -- '# Plan\n\n## Open Questions\n\n- Q1 (T3): @amila, Redis or in memory?\n- Q2: Which region first?\n' > "$tmp/inbox/tasks/plan.md"
check inbox-dashboard 'Wrote' node "$script" "$tmp/inbox" --dashboard "$tmp/inbox.html" --no-git
cat > "$tmp/inbox-script.js" <<'JS'
const html = require('fs').readFileSync(process.argv[2], 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const items = [...html.matchAll(/<li class="ib-item" data-who="([^"]*)"[\s\S]*?<p class="ib-text">([\s\S]*?)<\/p>/g)].map(m => ({ hidden: false, dataset: { who: m[1] }, text: m[2].replace(/<[^>]+>/g, '') }))
const me = html.match(/<select id="inbox-who" data-me="(\w+)">/)[1]
const iw = { value: '', dataset: { me } }
const tabs = [...html.matchAll(/role="tab" id="tab-(\w+)"/g)].map(m => ({ getAttribute: () => '#' + m[1], setAttribute() {}, addEventListener() {} }))
const views = Object.fromEntries(tabs.map(t => [t.getAttribute().slice(1), { hidden: false, querySelectorAll: q => (q === '[data-who]' ? items : []) }]))
const document = { body: { dataset: { view: 'overview' }, classList: { add() {}, toggle() {} } }, getElementById: id => (id === 'inbox-who' ? iw : id.startsWith('board-') ? null : views[id.replace(/^view-/, '')]), querySelectorAll: q => (q === '[role=tab]' ? tabs : []) }
let h = '#inbox?who=pm', on = {}
const location = { get hash() { return h }, set hash(v) { h = v.replace(/^#?/, '#') } }
require('vm').runInNewContext(script, { document, location, URLSearchParams, addEventListener: (t, f) => (on[t] = f) })
const shown = () => items.filter(i => !i.hidden).map(i => i.text.split(':')[0])
const fail = m => { console.log(m); process.exit(1) }
if (iw.value !== 'pm' || shown().join() !== 'Q2,approve SPEC.md') fail('who=pm showed ' + shown())
iw.value = 'amila'; iw.onchange()
if (location.hash !== '#inbox?who=amila') fail('the picker wrote ' + location.hash)
on.hashchange()
if (shown().join() !== 'Q1 (T3),Q2,approve SPEC.md') fail('who=amila showed ' + shown())
h = '#inbox?who=all'; on.hashchange()
if (shown().length !== items.length) fail('all hid some')
console.log('filtered')
JS
if out=$(node "$tmp/inbox-script.js" "$tmp/inbox.html" 2>&1); then echo "ok   inbox-tab-script ($out)"; else echo "FAIL inbox-tab-script: $out"; fail=1; fi

# The shared core imports only itself (J1).
if out=$(node "$here/purity.mjs" 2>&1); then echo "ok   core-purity ($out)"; else echo "FAIL core-purity:"; echo "$out" | sed 's/^/       /'; fail=1; fi

# The checker itself catches an import that leaves the library.
mkdir -p "$tmp/impure"; printf "import { x } from '../elsewhere'\nexport const y = x\n" > "$tmp/impure/a.ts"
if node "$here/purity.mjs" "$tmp/impure" >/dev/null 2>&1; then echo "FAIL core-purity-catches: an outside import passed"; fail=1; else echo "ok   core-purity-catches"; fi
mkdir -p "$tmp/api"; printf "// stands in for \$.process.run\nexport const run = (\$: any) => \$.process.run\n" > "$tmp/api/a.ts"
out=$(node "$here/purity.mjs" "$tmp/api" 2>&1)
if [[ $out == *"a.ts: uses the Claude Code API"* && $out == "1 offence"* || $out == *$'\n1 offence'* ]]; then echo "ok   core-purity-api (code caught, comment ignored)"; else echo "FAIL core-purity-api:"; echo "$out" | sed 's/^/       /'; fail=1; fi
exit $fail
