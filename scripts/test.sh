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
check colour $'\033[32m✓\033[0m T1' node "$script" "$tmp/build" --color --no-git
check no-color-env 'T1 Scaffold' env NO_COLOR=1 node "$script" "$tmp/build" --no-git
check bad-option 'unknown option --nope' node "$script" --nope
mkdir -p "$tmp/build/specs"; printf '# Spec: Auth\n## Objective\nx\n' > "$tmp/build/specs/auth.md"
check module-spec 'Spec · specs/auth.md' node "$script" "$tmp/build" --spec auth --no-color --no-git

out=$(node "$script" "$tmp/build" --no-color 2>&1)
if [[ $out == *Warning* ]]; then echo "FAIL no-warnings: Node printed a warning"; fail=1; else echo "ok   no-warnings"; fi
exit $fail
