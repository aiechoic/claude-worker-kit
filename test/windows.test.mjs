// Windows-only behaviour that can be checked anywhere: cmd.exe command lines for .cmd shims, launcher parsing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnTool, winCmdLine, winQuoteArg } from '../scripts/lib/team.mjs'
import { parseLauncher, pointsAt } from '../scripts/lib/teamclaude.mjs'

test('.cmd shims run through cmd.exe /d /s /c with every argument quoted and caret-escaped (no shell: true)', () => {
  assert.deepEqual(winCmdLine('lark-cli.cmd', ['profile', 'list']), ['/d', '/s', '/c', '"lark-cli.cmd ^^^"profile^^^" ^^^"list^^^""'])
  // metacharacters cannot break out: & | > % " all end up escaped inside the quoted argument
  assert.equal(winQuoteArg('a&b|c>d'), '^^^"a^^^&b^^^|c^^^>d^^^"')
  assert.equal(winQuoteArg('50%'), '^^^"50^^^%^^^"')
  assert.equal(winQuoteArg('say "hi"'), '^^^"say^^^ \\^^^"hi\\^^^"^^^"')
  assert.equal(winQuoteArg('C:\\dir\\'), '^^^"C:\\dir\\\\^^^"', 'trailing backslash doubled before the closing quote')
})

test('spawnTool only wraps .cmd / .bat on Windows', () => {
  const r = spawnTool(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }, 'linux')
  assert.equal(r.stdout, 'ok')
})

test('parseLauncher reads both the sh and the cmd launcher; foreign files are null', () => {
  const MARK = 'team-claude: feishu-channel-for-claude-code'
  assert.deepEqual(parseLauncher(`#!/bin/sh\n# ${MARK}\nTEAM_CLAUDE_INSTALLED_CONFIG='/c/it'\\''s.json' exec node '/repo/bin/start.mjs' "$@"\n`), { start: '/repo/bin/start.mjs', config: "/c/it's.json" })
  const cmd = `@echo off\r\nrem ${MARK}\r\nsetlocal\r\nset "TEAM_CLAUDE_INSTALLED_CONFIG=C:\\cfg\\50%%.json"\r\nnode "C:/repo/bin/start.mjs" %*\r\n`
  const l = parseLauncher(cmd)
  assert.deepEqual(l, { start: 'C:/repo/bin/start.mjs', config: 'C:\\cfg\\50%.json' })
  assert.equal(parseLauncher('#!/bin/sh\nexec something-else\n'), null)
  assert.ok(pointsAt({ ...l }, 'c:\\REPO', 'c:/cfg/50%.json', 'win32'), 'case and slashes do not matter on Windows')
})
