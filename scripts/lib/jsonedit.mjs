// Edit top-level keys of a JSON object in its text, leaving everything else (order, spacing, inline arrays) as written.

/** Spans of the top-level entries: [{ key, start, valueStart, valueEnd }], plus the closing brace and the entry indent. */
export function topLevel(text) {
  let i = text.indexOf('{')
  if (i < 0) throw new Error('not a JSON object')
  const entries = []
  let depth = 0; let inStr = false; let esc = false; let keyStart = -1; let key = null; let valueStart = -1
  let close = -1
  for (; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') {
        inStr = false
        if (depth === 1 && key === null && valueStart < 0) key = JSON.parse(text.slice(keyStart, i + 1))
      }
      continue
    }
    if (c === '"') {
      inStr = true
      if (depth === 1 && key === null && valueStart < 0) keyStart = i
      continue
    }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        if (key !== null) entries.push({ key, start: lineStart(text, keyStart), keyStart, valueStart, valueEnd: trimEnd(text, i) })
        close = i
        break
      }
      continue
    }
    if (depth === 1 && c === ':' && key !== null && valueStart < 0) { valueStart = skipWs(text, i + 1); continue }
    if (depth === 1 && c === ',') {
      entries.push({ key, start: lineStart(text, keyStart), keyStart, valueStart, valueEnd: trimEnd(text, i) })
      key = null; valueStart = -1
    }
  }
  if (close < 0) throw new Error('unterminated JSON object')
  const indent = entries.length ? /^[ \t]*/.exec(text.slice(entries[0].start))[0] : '  '
  return { entries, close, indent }
}

function skipWs(t, i) { while (/\s/.test(t[i])) i++; return i }
function trimEnd(t, i) { while (i > 0 && /\s/.test(t[i - 1])) i--; return i }
/** The start of the key's line when only spaces precede it there, else the key itself (one-line objects). */
function lineStart(t, i) { const ls = t.lastIndexOf('\n', i - 1) + 1; return t.slice(ls, i).trim() === '' ? ls : i }

/** The value written the way the old one was: on one line if the old one was, otherwise indented under its key. */
function render(value, oldText, indent) {
  if (oldText !== undefined && !oldText.includes('\n')) return inline(value, /,\s/.test(oldText) ? ', ' : ',', /:\s/.test(oldText) ? ': ' : ':')
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return JSON.stringify(value, null, indent).split('\n').join(`\n${indent}`)
}

/** One-line JSON with the old value's separators (`["a", "b"]` stays spaced). */
function inline(v, comma, colon) {
  if (Array.isArray(v)) return `[${v.map(x => inline(x, comma, colon)).join(comma)}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}${colon}${inline(x, comma, colon)}`).join(comma)}}`
  return JSON.stringify(v)
}

/** Set (add or replace) one top-level key. */
export function setKey(text, key, value) {
  const { entries, close, indent } = topLevel(text)
  const e = entries.find(x => x.key === key)
  if (e) {
    const old = text.slice(e.valueStart, e.valueEnd)
    return text.slice(0, e.valueStart) + render(value, old, indent) + text.slice(e.valueEnd)
  }
  const last = entries[entries.length - 1]
  const piece = `${indent}${JSON.stringify(key)}: ${render(value, undefined, indent)}`
  if (!last) return `${text.slice(0, close)}\n${piece}\n${text.slice(close)}`
  return `${text.slice(0, last.valueEnd)},\n${piece}${text.slice(last.valueEnd)}`
}

/** Remove one top-level key (and its comma). */
export function deleteKey(text, key) {
  const { entries } = topLevel(text)
  const i = entries.findIndex(x => x.key === key)
  if (i < 0) return text
  const e = entries[i]
  if (i < entries.length - 1) return text.slice(0, e.start) + text.slice(entries[i + 1].start)
  if (i === 0) return text.slice(0, e.start) + text.slice(e.valueEnd).replace(/^[^\S\n]*\n?/, '')
  const prev = entries[i - 1]
  return text.slice(0, prev.valueEnd) + text.slice(e.valueEnd)
}
