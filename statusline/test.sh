#!/usr/bin/env bash
# Runs the status line against sample projects and checks the stage it prints.
set -u
here=$(cd "$(dirname "$0")" && pwd)
script="$here/agent-skills-status.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0

check() { # name dir expected-substring
  local out
  out=$(printf '{"workspace":{"current_dir":"%s"},"model":{"display_name":"M"}}' "$2" | ASM_STATUS_PREFIX=0 bash "$script" | sed $'s/\033\\[[0-9;]*m//g')
  if [[ $out == *"$3"* ]]; then echo "ok   $1: $out"; else echo "FAIL $1: got '$out', want '$3'"; fail=1; fi
}

mkdir -p "$tmp/none"
out=$(printf '{"workspace":{"current_dir":"%s"},"model":{"display_name":"M"}}' "$tmp/none" | bash "$script" | sed $'s/\033\\[[0-9;]*m//g')
if [[ $out == *"[M]" && $out != *spec* ]]; then echo "ok   none: $out"; else echo "FAIL none: $out"; fail=1; fi

mkdir -p "$tmp/spec"; printf '# Spec: X\n## Objective\nx\n' > "$tmp/spec/SPEC.md"
check spec-only "$tmp/spec" '♦spec ○plan ○build ○review ○ship'

mkdir -p "$tmp/approved"; printf -- '---\nstatus: approved\n---\n# Spec: X\n' > "$tmp/approved/SPEC.md"
check spec-approved "$tmp/approved" '✓spec ○plan'

mkdir -p "$tmp/build/tasks"; cat > "$tmp/build/tasks/todo.md" <<'EOF'
## Task 1: Scaffold
- [x] builds
**Dependencies:** None
## Task 2: Prisma schema for keys
- [x] table
- [ ] migration
## Checkpoint: After Tasks 1-2
- [ ] tests pass
## Task 3: Issue keys
- [ ] POST /keys
EOF
check mid-build "$tmp/build" '✓spec ✓plan ●build 1/3 ○review ○ship · T2 Prisma schema for keys'

# T2 waits on T3, so the next task is T3, as on the board and band.
mkdir -p "$tmp/blocked/tasks"; cat > "$tmp/blocked/tasks/todo.md" <<'EOF'
## Task 1: Scaffold
- [x] builds
## Task 2: Usage API
**Dependencies:** Task 3
- [ ] GET /usage
## Task 3: Usage counter
**Dependencies:** Task 1
- [ ] counts calls
EOF
check blocked "$tmp/blocked" '●build 1/3 ○review ○ship · T3 Usage counter'

# Every open task is blocked: no task is named.
mkdir -p "$tmp/allblocked/tasks"; printf '## Task 1: A\n**Dependencies:** Task 2\n- [ ] a\n## Task 2: B\n**Dependencies:** T1\n- [ ] b\n' > "$tmp/allblocked/tasks/todo.md"
out=$(printf '{"workspace":{"current_dir":"%s"}}' "$tmp/allblocked" | ASM_STATUS_PREFIX=0 bash "$script" | sed $'s/\033\\[[0-9;]*m//g')
if [[ $out == *"●build 0/2 ○review ○ship" ]]; then echo "ok   all-blocked: $out"; else echo "FAIL all-blocked: $out"; fail=1; fi

mkdir -p "$tmp/index/tasks"; cat > "$tmp/index/tasks/plan.md" <<'EOF'
### Phase 1: Foundation
- [x] Task 1: Model
- [x] Task 2: Worker
### Checkpoint: Foundation
- [ ] Tests pass
### Phase 2: Core
- [ ] Task 3: Email channel
EOF
check plan-index "$tmp/index" '●build 2/3 ○review ○ship · T3 Email channel'

mkdir -p "$tmp/free/tasks"; printf '# TODO\n- [x] set up repo\n- [ ] write the parser\n- [ ] ship it\n' > "$tmp/free/tasks/todo.md"
check free-form "$tmp/free" '●build 1/3 ○review ○ship · #2 write the parser'

mkdir -p "$tmp/done/tasks"; printf '## Task 1: A\n- [x] a\n## Task 2: B\n- [x] b\n' > "$tmp/done/tasks/todo.md"
check all-done "$tmp/done" '✓build 2/2 ●review'

start=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(time.time_ns())')
for _ in $(seq 20); do printf '{"workspace":{"current_dir":"%s"}}' "$tmp/build" | bash "$script" >/dev/null; done
end=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(time.time_ns())')
[[ $start == *N ]] || echo "time per run: $(( (end - start) / 20000000 )) ms"

exit $fail
