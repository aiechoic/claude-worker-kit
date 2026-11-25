// A fake `docker` for the host and repos tests (written to a bin directory on PATH).
// fake docker: state in $FAKE_STATE (containers name → running, images list), every call appended to $FAKE_LOG
export const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const S = process.env.FAKE_STATE, L = process.env.FAKE_LOG
const st = JSON.parse(fs.readFileSync(S, 'utf8'))
const a = process.argv.slice(2)
fs.appendFileSync(L, a.join(' ') + '\\n')
if (process.env.FAKE_FAIL === a[0]) {
  if (a[0] === 'build') for (let i = 1; i <= 80; i++) console.log('build line ' + i)
  console.error('fake ' + a[0] + ' failure')
  process.exit(1)
}
const save = () => fs.writeFileSync(S, JSON.stringify(st))
const has = n => n in st.containers
let code = 0
if (a[0] === 'info') code = 0
else if (a[0] === 'container' && a[1] === 'inspect') {
  const n = a[a.length - 1]
  if (!has(n)) code = 1
  else if (a[2] === '-f' && a[3].includes('.Image')) console.log((st.imageOf || {})[n] || 'sha256:old')
  else if (a[2] === '-f' && a[3].includes('compose.project')) console.log((st.labels || {})[n] || '<no value>')
  else if (a[2] === '-f') console.log(String(st.containers[n]))
} else if (a[0] === 'image' && a[1] === 'inspect') code = st.images.includes(a[2]) ? 0 : 1
else if (a[0] === 'tag') { if (!st.images.includes(a[1]) && !a[1].startsWith('sha256:')) code = 1; else { st.images.push(a[2]); save() } }
else if (a[0] === 'cp') { const [src, dest] = [a[1], a[2]]; if (dest.includes(':/')) { const k = dest.indexOf(':/'), c = dest.slice(0, k), p = dest.slice(k + 1); if (!has(c)) code = 1; else { st.copied = st.copied || {}; st.copied[p] = fs.statSync(src).isDirectory() ? 'dir' : fs.readFileSync(src, 'utf8'); save() } } }
else if (a[0] === 'build') { st.images.push('built'); save() }
else if (a[0] === 'rmi') { if (!st.images.includes(a[1])) code = 1; else { st.images = st.images.filter(i => i !== a[1]); save() } }
else if (a[0] === 'stop') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = false; save() } }
else if (a[0] === 'start') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = true; save() } }
else if (a[0] === 'rename') { if (!has(a[1]) || has(a[2])) code = 1; else { st.containers[a[2]] = st.containers[a[1]]; delete st.containers[a[1]]; save() } }
else if (a[0] === 'rm') { delete st.containers[a[2]]; save() }
else if (a[0] === 'exec') {
  let i = 1, user = null
  let stdin = false
  for (; i < a.length && a[i].startsWith('-'); i++) { if (a[i] === '-u') user = a[++i]; else if (a[i] === '-w') i++; else if (a[i] === '-i') stdin = true }
  if (stdin && !process.env.FAKE_EXEC_RUN) { st.stdin = (st.stdin || []).concat(fs.readFileSync(0, 'latin1')); save() }
  const rest = a.slice(i + 1)
  st.copied = st.copied || {}
  if (rest[0] === 'rm') { delete st.copied[rest[rest.length - 1]]; save() }
  else if (rest[0] === 'bash' && rest[1] === '-l' && st.copied[rest[2]] !== undefined) {
    const text = st.copied[rest[2]]
    st.ran = (st.ran || []).concat({ user, text }); save()
    if (process.env.FAKE_EXEC_RUN) {
      const r = require('child_process').spawnSync('bash', ['-c', text], { stdio: 'inherit' })
      code = r.status ?? 1
    }
  } else if (process.env.FAKE_EXEC_RUN && rest[0] === 'test') code = require('child_process').spawnSync(rest[0], rest.slice(1)).status
}
else if (a[0] === 'compose') {
  const i = a.indexOf('-p'), c = process.env.FAKE_CONTAINER
  if (a.includes('down')) { delete st.containers[c]; st.downs = (st.downs || []).concat(a[i + 1]) }
  else { st.containers[c] = true; st.labels = { ...(st.labels || {}), [c]: a[i + 1] }; st.projects = (st.projects || []).concat(a[i + 1]) }
  save()
}
else code = 2
process.exit(code)
`

