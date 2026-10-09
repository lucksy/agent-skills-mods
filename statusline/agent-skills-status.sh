#!/usr/bin/env bash
# Claude Code status line: user@host:dir [model] · agent-skills stage of the project.
#
#   ✓spec ✓plan ●build 2/4 ○review ○ship · T2 Prisma schema for keys
#
# Reads SPEC.md, tasks/plan.md and tasks/todo.md (agent-skills conventions) from the
# session's folder. Projects without any of them get the plain line. Needs jq.
# Set ASM_STATUS_PREFIX=0 to print the stage alone (to append to your own line).

IFS=$'\t' read -r dir model < <(jq -r '[.workspace.current_dir // .cwd // "", .model.display_name // ""] | @tsv')
[[ -z $dir ]] && dir=$PWD

G=$'\033[32m'; B=$'\033[34m'; M=$'\033[35m'; Y=$'\033[33m'; D=$'\033[2m'; R=$'\033[0m'

line=""
if [[ ${ASM_STATUS_PREFIX:-1} != 0 ]]; then
  line="${G}$(whoami)@$(hostname -s)${R}:${B}$(basename "$dir")${R} [${M}${model}${R}]"
fi

spec="$dir/SPEC.md"; plan="$dir/tasks/plan.md"; todo="$dir/tasks/todo.md"
if [[ ! -f $spec && ! -f $plan && ! -f $todo ]]; then
  printf '%s' "$line"; exit 0
fi

# Same rules as hooks/lib/parse.ts:
# - "## Task N: title" sections: done when every box in the section is ticked;
# - "- [ ] Task N: title" lines (the plan's index): done when ticked;
# - otherwise every checkbox is one item (a free-form checklist).
# Checkpoint sections never count as tasks. Prints: done total next_id next_title
list=$todo; [[ -f $list ]] || list=$plan
read -r done total next_id next_title < <(
  [[ -f $list ]] && awk '
    function close_task() {
      if (cur == "") return
      n++; id[n] = cur; ttl[n] = title; isdone[n] = (unchecked == 0 && boxes > 0)
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
        cur = "T" num; title = t; boxes = 0; unchecked = 0
      } else if (h ~ /^[Cc]heckpoint/) incp = 1
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
      d = 0; nid = "-"; nt = "-"
      for (i = 1; i <= n; i++) {
        if (isdone[i]) d++
        else if (nid == "-") { nid = id[i]; nt = ttl[i] }
      }
      gsub(/[ \t]+/, "_", nt); if (nt == "") nt = "-"
      printf "%d %d %s %s\n", d, n, nid, nt
    }' "$list" || echo "0 0 - -"
)

# Spec approval: front matter "status: approved|draft" wins; else a plan existing
# means the spec gate was passed (planning only starts after approval).
fm=""
[[ -f $spec ]] && fm=$(awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} NR>1 && /^status:/ {sub(/^status:[ \t]*/, ""); gsub(/["\047]/, ""); print; exit}' "$spec")
if   [[ $fm == approved ]];          then s="${G}✓spec${R}"
elif [[ $fm == draft && -f $spec ]]; then s="${M}♦spec${R}"
elif [[ -f $plan || -f $todo ]];     then s="${G}✓spec${R}"
elif [[ -f $spec ]];                 then s="${M}♦spec${R}"
else                                      s="${D}○spec${R}"; fi

if [[ -f $todo || -f $plan ]]; then p="${G}✓plan${R}"; else p="${D}○plan${R}"; fi

if (( total == 0 )); then
  b="${D}○build${R}"; rv="${D}○review${R}"
elif (( done < total )); then
  b="${Y}●build ${done}/${total}${R}"; rv="${D}○review${R}"
else
  b="${G}✓build ${done}/${total}${R}"; rv="${Y}●review${R}"
fi

stage="$s $p $b $rv ${D}○ship${R}"
if [[ $next_id != "-" ]]; then
  t=${next_title//_/ }
  (( ${#t} > 28 )) && t="${t:0:27}…"
  stage+=" ${D}·${R} ${next_id} ${t}"
fi

if [[ -n $line ]]; then printf '%s %s·%s %s' "$line" "$D" "$R" "$stage"; else printf '%s' "$stage"; fi
