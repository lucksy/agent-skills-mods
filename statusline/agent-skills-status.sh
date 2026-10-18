#!/usr/bin/env bash
# Claude Code status line: one calm line, where the work is and what comes next.
#
#   agent-skills-mods · build 4/9 · T4 Rate limit per key · Opus 5.5
#   agent-skills-mods · ✓ built 9/9 → /review · Opus 5.5
#
# Only the current stage: the ones behind it are implied. What needs you (a spec
# awaiting approval, nothing able to start) is the mod's status entry, drawn with
# a ⚠ only then. Reads SPEC.md, tasks/plan.md and tasks/todo.md (agent-skills
# conventions) from the session's folder; other projects get `dir · model`.
# Needs jq. Set ASM_STATUS_PREFIX=0 to print the stage alone (to append to your own line).

IFS=$'\t' read -r dir model < <(jq -r '[.workspace.current_dir // .cwd // "", .model.display_name // ""] | @tsv')
[[ -z $dir ]] && dir=$PWD

G=$'\033[32m'; B=$'\033[34m'; M=$'\033[35m'; Y=$'\033[33m'; D=$'\033[2m'; R=$'\033[0m'
SEP=" ${D}·${R} "

# Folder first, model last and dim: the stage between them is what changes.
out() { # stage
  local parts=()
  [[ ${ASM_STATUS_PREFIX:-1} != 0 ]] && parts+=("${B}$(basename "$dir")${R}")
  [[ -n $1 ]] && parts+=("$1")
  [[ ${ASM_STATUS_PREFIX:-1} != 0 && -n $model ]] && parts+=("${D}${model}${R}")
  local IFS=$'\x1f'; local joined="${parts[*]}"
  printf '%s' "${joined//$'\x1f'/$SEP}"
}

spec="$dir/SPEC.md"; plan="$dir/tasks/plan.md"; todo="$dir/tasks/todo.md"
if [[ ! -f $spec && ! -f $plan && ! -f $todo ]]; then
  out ""; exit 0
fi

# Same rules as packages/core/parse.ts:
# - "## Task N: title" sections: done when every box in the section is ticked,
#   blocked while a task named on its **Dependencies:** line isn't done;
# - "- [ ] Task N: title" lines (the plan's index): done when ticked;
# - otherwise every checkbox is one item (a free-form checklist).
# Checkpoint sections never count as tasks. Prints: done total next_id next_title
list=$todo; [[ -f $list ]] || list=$plan
read -r done total next_id next_title < <(
  [[ -f $list ]] && awk '
    function close_task() {
      if (cur == "") return
      n++; id[n] = cur; ttl[n] = title; isdone[n] = (unchecked == 0 && boxes > 0); deps[n] = curdeps
      cur = ""
    }
    /^[ \t]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    /^#+[ \t]/ {
      close_task(); incp = 0
      h = $0; sub(/^#+[ \t]+/, "", h); gsub(/\*\*/, "", h)
      if (h ~ /^[Tt]ask[ \t]+[0-9]+[ \t]*[:.]/) {
        t = h; sub(/^[Tt]ask[ \t]+/, "", t); num = t; sub(/[^0-9].*$/, "", num)
        sub(/^[0-9]+[ \t]*[:.][ \t]*/, "", t)
        cur = "T" num; title = t; boxes = 0; unchecked = 0; curdeps = ""
      } else if (h ~ /^[Cc]heckpoint/) incp = 1
      next
    }
    /^[ \t]*\*\*[Dd]ependencies:?\*\*/ {
      if (cur == "") next
      d = $0; sub(/^[ \t]*\*\*[Dd]ependencies:?\*\*:?/, "", d)
      while (match(d, /[0-9]+/)) { curdeps = curdeps " T" substr(d, RSTART, RLENGTH); d = substr(d, RSTART + RLENGTH) }
      next
    }
    /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/ {
      ticked = ($0 ~ /\[[xX]\]/)
      if (cur != "") { boxes++; if (!ticked) unchecked++; next }
      if (incp) next
      text = $0; sub(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, "", text); gsub(/\*\*|`/, "", text)
      if (text ~ /^[Tt]ask[ \t]+[0-9]+[ \t]*[:.]/) {
        t = text; sub(/^[Tt]ask[ \t]+/, "", t); num = t; sub(/[^0-9].*$/, "", num)
        sub(/^[0-9]+[ \t]*[:.][ \t]*/, "", t)
        if (!("T" num in seen)) { n++; id[n] = "T" num; ttl[n] = t; isdone[n] = ticked; seen["T" num] = n }
      } else {
        m++; lid[m] = "#" m; lttl[m] = text; ldone[m] = ticked
      }
    }
    END {
      close_task()
      if (n == 0) for (i = 1; i <= m; i++) { n++; id[n] = lid[i]; ttl[n] = lttl[i]; isdone[n] = ldone[i] }
      # The next task is the first one not done whose known dependencies are all done.
      for (i = 1; i <= n; i++) { known[id[i]] = 1; if (isdone[i]) fin[id[i]] = 1 }
      d = 0; nid = "-"; nt = "-"
      for (i = 1; i <= n; i++) {
        if (isdone[i]) { d++; continue }
        if (nid != "-") continue
        blocked = 0; k = split(deps[i], dl, " ")
        for (j = 1; j <= k; j++) if ((dl[j] in known) && !(dl[j] in fin)) blocked = 1
        if (!blocked) { nid = id[i]; nt = ttl[i] }
      }
      gsub(/[ \t]+/, "_", nt); if (nt == "") nt = "-"
      printf "%d %d %s %s\n", d, n, nid, nt
    }' "$list" || echo "0 0 - -"
)

# Spec approval: front matter "status: approved|draft" wins; else a plan existing
# means the spec gate was passed (planning only starts after approval).
fm=""
[[ -f $spec ]] && fm=$(awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} NR>1 && /^status:/ {sub(/^status:[ \t]*/, ""); gsub(/["\047]/, ""); print; exit}' "$spec")
if   [[ $fm == approved ]];          then approved=1
elif [[ $fm == draft && -f $spec ]]; then approved=0
elif [[ -f $plan || -f $todo ]];     then approved=1
else                                      approved=0; fi

# The one stage that matters now, and the step after it.
if (( ! approved )); then
  stage="${M}♦ spec draft${R}"
elif [[ ! -f $todo && ! -f $plan ]]; then
  stage="${G}✓ spec${R} ${D}→ /plan${R}"
elif (( total == 0 )); then
  stage="${G}✓ plan${R} ${D}→ /build${R}"
elif (( done < total )); then
  stage="${Y}build ${done}/${total}${R}"
  if [[ $next_id != "-" ]]; then
    t=${next_title//_/ }
    (( ${#t} > 28 )) && t="${t:0:27}…"
    stage+="${SEP}${next_id} ${t}"
  else
    stage+="${SEP}${M}blocked${R}"
  fi
else
  stage="${G}✓ built ${done}/${total}${R} ${D}→ /review${R}"
fi

out "$stage"
