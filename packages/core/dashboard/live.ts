// The live dashboard's write buttons (team-view, T11). Only `--serve` asks for
// them: the views call these helpers when `live` is set, and the static page
// never does, so it has no buttons and no script for them. Each button names its
// task (`Start T4`) and carries its action and args; a text field opens an inline
// form, never a browser prompt. LIVE_SCRIPT posts them with the page's rev,
// says the reply in a polite live region, and reloads when the files change. Pure.

import { esc } from './html'

/** Where a control sits, so two copies of a card (columns and lanes) get ids of their own. */
export type LiveAt = string

const attrs = (act: string, args: Record<string, unknown>) => `data-act="${act}" data-args="${esc(JSON.stringify(args))}"`

/** The key a reload refocuses by: the same control in whichever copy of the card is showing. */
const keyOf = (act: string, subject: string) => esc(`${act}-${subject}`)

/**
 * A button that runs `act` at once. `label` is what it shows; `name` what it is
 * called (it starts with the label, so a voice command for what you see works).
 */
export function actButton(act: string, args: Record<string, unknown>, label: string, name: string, subject: string): string {
  return `<button type="button" class="act" ${attrs(act, args)} data-k="${keyOf(act, subject)}" aria-label="${esc(name)}">${esc(label)}</button>`
}

/** A field of an inline form: its name in the action's args, what the label says, and an example. */
export type LiveField = { name: string; label: string; hint?: string }

/**
 * A button that opens an inline form for the text an action needs (why it is
 * blocked, the answer, who takes it and the note), then the form itself, hidden.
 */
export function actForm(act: string, args: Record<string, unknown>, o: { label: string; name: string; submit: string; fields: LiveField[]; subject: string; at: LiveAt }): string {
  const id = `f-${o.at}-${act}-${o.subject}`.replace(/[^\w-]/g, '-')
  const fields = o.fields
    .map(f => `<label>${esc(f.label)} <input name="${f.name}" required autocomplete="off"${f.hint ? ` placeholder="${esc(f.hint)}"` : ''}></label>`)
    .join('')
  return `<button type="button" class="act" data-open aria-expanded="false" aria-controls="${id}" data-k="${keyOf(`open-${act}`, o.subject)}" aria-label="${esc(o.name)}">${esc(o.label)}…</button>\
<form class="act-form" id="${id}" hidden ${attrs(act, args)} data-k="${keyOf(`form-${act}`, o.subject)}">${fields}<span class="act-row"><button type="submit" class="act act-go">${esc(o.submit)}</button><button type="button" class="act" data-cancel>Cancel</button></span></form>`
}

/** A box as a toggle: pressed when ticked, named by its task and its text. */
export function tickButton(id: string, index: number, done: boolean, html: string): string {
  return `<button type="button" class="act tick" ${attrs('tick', { id, index })} data-k="${keyOf('tick', `${id}-${index}`)}" aria-pressed="${done}"><span class="g" aria-hidden="true">${done ? '✓' : '☐'}</span><span><span class="vh">${esc(id)}: </span>${html}</span></button>`
}

/**
 * A task's size as a group of toggles (ceremonies T12): S, M, L and – (none),
 * the current one pressed. Each posts `size`; pressing the current one changes nothing.
 */
export function sizePicker(id: string, size: string | undefined): string {
  const opt = (v: string, label: string, name: string) =>
    `<button type="button" class="act sz-b" ${attrs('size', { id, size: v })} data-k="${keyOf('size', `${id}-${v}`)}" aria-pressed="${(size ?? '-') === v}" aria-label="${esc(name)}">${label}</button>`
  return `<span class="sz" role="group" aria-label="Size of ${esc(id)}"><span class="sz-l" aria-hidden="true">Size</span>${['S', 'M', 'L'].map(v => opt(v, v, `${v} size for ${id}`)).join('')}${opt('-', '–', `No size for ${id}`)}</span>`
}

/** The row of buttons under a card or an item. */
export const actRow = (buttons: string[]) => (buttons.length ? `<div class="acts">${buttons.join('')}</div>` : '')

/** Where the replies are said: one polite live region, present from the start so screen readers follow it. */
export const LIVE_STATUS = '<div id="live-msg" class="live-msg" role="status" aria-live="polite"></div>'

/** The live page may call its own server, and nothing else. */
export const LIVE_CSP = "; connect-src 'self'"

/** 409's notice: nothing was written, and the page now shows what is on disk. */
export const LIVE_STALE = 'This changed since the page loaded, so nothing was saved. The page now shows the latest; check it and try again.'

/**
 * Posts each button's action with the page's rev and the token from the address.
 * While it runs the button is marked disabled (it keeps focus) and other clicks
 * are told to wait. 200 and 409 reload, keeping the reply, the focus and any
 * text typed into a form; 400 says the action's refusal. A `changed` event
 * reloads too when the rev moved, unless a form is open: then it waits until
 * the form closes.
 */
export const LIVE_SCRIPT = /* indentation and comment lines dropped, to keep it under 4 KB */ `(() => {
  const d = document, b = d.body, S = sessionStorage, K = 'asm-live', msg = d.getElementById('live-msg')
  const tok = new URLSearchParams(location.search).get('token') || ''
  let busy = null, stale = false
  const say = t => { msg.textContent = ''; setTimeout(() => { msg.textContent = t }, 60) }
  // The showing copy of a control: a closed form by its button, a box inside a closed fold opens it.
  const find = k => {
    const all = k ? [...d.querySelectorAll('[data-k="' + CSS.escape(k) + '"]')] : []
    return all.find(e => {
      const x = e.closest('details')
      if (x) { if (!x.offsetParent) return false; x.open = true }
      return e.offsetParent || (e.hidden && e.previousElementSibling.offsetParent)
    })
  }
  const openForm = (o, on) => {
    const f = d.getElementById(o.getAttribute('aria-controls'))
    f.hidden = !on
    o.setAttribute('aria-expanded', on)
    if (on) f.querySelector('input').focus()
    else { o.focus(); if (stale) reload('Reloaded: the files changed on disk.', o) }
    return f
  }
  const reload = (m, el, form, task) => {
    busy = 1
    S.setItem(K, JSON.stringify({ m, k: el && el.dataset.k, t: task, f: form && form.dataset.k, v: form && Object.fromEntries(new FormData(form)) }))
    location.reload()
  }
  const was = JSON.parse(S.getItem(K) || 'null')
  S.removeItem(K)
  if (was) {
    let el = find(was.k)
    const f = find(was.f)
    if (f) {
      const o = d.querySelector('[aria-controls="' + f.id + '"]')
      if (o) openForm(o, true)
      for (const [n, v] of Object.entries(was.v || {})) if (f.elements[n]) f.elements[n].value = v
      el = f.querySelector('input')
    }
    if (!el && was.t) { el = d.querySelector('#card-' + CSS.escape(was.t)); if (el) el.tabIndex = -1 }
    // Gone (a question answered): back to the view it was on.
    ;(el || d.getElementById('view-' + b.dataset.view)).focus()
    say(was.m)
  }
  const send = async (btn, act, args, form) => {
    if (busy) return say('Wait: the last change is still being saved.')
    busy = btn
    btn.setAttribute('aria-disabled', 'true')
    say('Saving…')
    let r = null, j = {}
    try {
      r = await fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-skills-token': tok }, body: JSON.stringify({ action: act, args, rev: b.dataset.rev }) })
      j = await r.json()
    } catch {}
    btn.removeAttribute('aria-disabled')
    busy = null
    if (r && r.status === 200) return reload(j.reply, form ? d.querySelector('[aria-controls="' + form.id + '"]') : btn, null, args.id)
    if (r && r.status === 409) return reload(${JSON.stringify(LIVE_STALE)}, btn, form, args.id)
    say(r ? j.reply || 'The server said ' + r.status + '.' : 'Could not reach the server: is --serve still running?')
    if (form) form.querySelector('input').focus()
  }
  d.addEventListener('click', e => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.hasAttribute('data-open')) openForm(t, t.getAttribute('aria-expanded') !== 'true')
    else if (t.hasAttribute('data-cancel')) openForm(d.querySelector('[aria-controls="' + t.form.id + '"]'), false)
    else if (t.dataset.act) send(t, t.dataset.act, JSON.parse(t.dataset.args), null)
  })
  d.addEventListener('submit', e => {
    const f = e.target
    if (!f.dataset.act) return
    e.preventDefault()
    const a = JSON.parse(f.dataset.args)
    for (const [n, v] of new FormData(f)) a[n] = v
    send(f.querySelector('[type=submit]'), f.dataset.act, a, f)
  })
  d.addEventListener('keydown', e => {
    const f = e.key === 'Escape' && e.target.closest && e.target.closest('.act-form')
    if (f) openForm(d.querySelector('[aria-controls="' + f.id + '"]'), false)
  })
  // A \`changed\` reloads only when the files differ from what this page shows (not for the write it just reloaded for).
  new EventSource('/events?token=' + encodeURIComponent(tok)).addEventListener('changed', async () => {
    const r = await fetch(location.pathname + location.search).catch(() => null)
    if (busy || !r || r.headers.get('x-agent-skills-rev') === b.dataset.rev) return
    if (d.querySelector('.act-form:not([hidden])')) { stale = true; return say('The files changed on disk. The page reloads when you close the form.') }
    reload('Reloaded: the files changed on disk.', d.activeElement)
  })
})()`
  .replace(/^\s*\/\/.*\n/gm, '')
  .replace(/^\s+/gm, '')

/** The buttons, the forms and the live region, in the page's tokens: light and dark, wrapping at 360 px. */
export const LIVE_STYLE = `
body{padding-bottom:72px}
.acts{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s2);margin-top:var(--s2)}
.act{font:inherit;font-size:13px;line-height:1.2;min-height:28px;padding:var(--s1) var(--s3);color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:var(--r);cursor:pointer}
.act:hover{border-color:var(--ink3)}
.act[aria-disabled=true]{opacity:.6;cursor:progress}
.act-go{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.act-form:not([hidden]){display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--s2);margin-top:var(--s2);padding:var(--s2);border:1px solid var(--line2);border-radius:var(--r);background:var(--bg)}
.act-form label{display:flex;flex-direction:column;gap:2px;font-size:12.5px;color:var(--ink2);flex:1 1 160px;min-width:0}
.act-form input{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:var(--r);padding:var(--s1) var(--s2);min-height:30px;width:100%}
.act-row{display:flex;gap:var(--s2)}
.tick{display:flex;gap:var(--s2);align-items:baseline;width:100%;text-align:left;border-color:transparent;background:none;padding:2px var(--s1)}
.tick:hover{border-color:var(--line2)}
.tick[aria-pressed=true]>span:last-child{color:var(--ink3);text-decoration:line-through}.tick[aria-pressed=true] .g{color:var(--done)}
.c-boxes{margin-top:var(--s2);font-size:12.5px}.c-boxes summary{cursor:pointer;color:var(--ink2)}.c-boxes ul{list-style:none;margin:var(--s1) 0 0;padding:0}
.sz{display:inline-flex;align-items:center;gap:2px}.sz-l{font-size:12.5px;color:var(--ink2);margin-right:var(--s1)}
.sz-b{min-width:28px;padding:var(--s1) var(--s2)}.sz-b[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.live-msg{position:fixed;left:50%;bottom:var(--s4);transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);background:var(--ink);color:var(--bg);border-radius:var(--r);padding:var(--s2) var(--s3);font-size:13.5px;z-index:3}
.live-msg:empty{padding:0}
`
