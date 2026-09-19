import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { doctor, listSites } from '../src/doctor.js'
import { makeSite, makeWorkspace, write } from './helpers.js'

test('清单与磁盘一致时不报问题', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = makeSite(workspace)
  assert.deepEqual(doctor(dir, site), [])
})

test('doc 页缺正文文件 → dangling', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = makeSite(workspace)
  rmSync(join(dir, 'pages', 'login-doc.md'))

  const problems = doctor(dir, site)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'dangling')
  assert.match(problems[0].message, /LO-01/)
  assert.match(problems[0].message, /pages\/login-doc\.md/)
})

test('proto 页缺入口 → dangling，认 entry 覆盖', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  rmSync(join(dir, 'prototypes', 'login-proto', 'index.html'))
  assert.equal(doctor(dir, site)[0].kind, 'dangling')

  // 入口换成别的名字，并在清单里声明它
  write(workspace, `sites/${id}/prototypes/login-proto/main.html`, '<!doctype html>')
  site.modules[0].pages[1].entry = 'main.html'
  assert.deepEqual(doctor(dir, site), [])
})

test('磁盘上多出的页面文件 → orphan，并带上 path 供编辑器使用', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/extra.md`, '## 孤儿\n')
  write(workspace, `sites/${id}/prototypes/extra/index.html`, '<!doctype html>')

  const orphans = doctor(dir, site).filter((problem) => problem.kind === 'orphan')
  assert.equal(orphans.length, 2)
  assert.deepEqual(orphans.map((problem) => problem.path).sort(), ['pages/extra.md', 'prototypes/extra'])
})

test('assets/ 里的文件不算 orphan（它由正文引用，不进清单）', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/assets/pic.png`, 'x')
  assert.deepEqual(doctor(dir, site), [])
})

test('点开头的文件不算 orphan（编辑器的临时文件）', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/.login-doc.md.swp`, 'x')
  assert.deepEqual(doctor(dir, site), [])
})

test('page id 或 code 重复 → duplicate', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = makeSite(workspace, 'demo', (draft) => {
    draft.modules[0].pages.push({ id: 'login-doc', code: 'LO-03', type: 'doc', title: '撞 id 的' })
    draft.modules[0].pages.push({ id: 'another', code: 'LO-01', type: 'doc', title: '撞 code 的' })
    return draft
  })

  const messages = doctor(dir, site).map((problem) => problem.message)
  assert.equal(messages.filter((line) => line.includes('id 重复')).length, 1)
  assert.equal(messages.filter((line) => line.includes('code 重复')).length, 1)
})

test('listSites 只认带 site.json 的目录，跳过点开头的，按名字排序', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'beta')
  makeSite(workspace, 'alpha')
  mkdirSync(join(workspace, 'sites', 'no-manifest'))
  write(workspace, 'sites/.hidden/site.json', '{}')

  assert.deepEqual(listSites(workspace).map((entry) => entry.id), ['alpha', 'beta'])
})
