import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildSite, buildTargets } from '../src/build.js'
import { listSites } from '../src/doctor.js'
import { makeSite, makeWorkspace, write } from './helpers.js'

const byId = (workspace, id) => listSites(workspace).find((site) => site.id === id)

test('构建成功：产物自包含，导航树与锚点都烘进 HTML', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, true)
  assert.equal(result.pages, 2)
  assert.equal(result.forced, false)

  const dist = join(workspace, 'sites', id, 'dist')
  for (const rel of ['index.html', 'login-doc.html', 'login-proto.html', 'kebab.css']) {
    assert.ok(existsSync(join(dist, rel)), `缺产物：${rel}`)
  }
  assert.ok(existsSync(join(dist, 'prototypes', 'login-proto', 'index.html')), '原型目录原样复制')

  const html = readFileSync(join(dist, 'login-doc.html'), 'utf8')
  assert.match(html, /LO-01/)
  assert.match(html, /LO-02/)
  assert.match(html, /class="is-current"/, '当前页要高亮')
  assert.match(html, /id="login-doc-1"/, '条目编号与锚点')
  assert.ok(!html.includes('<script'), '产物不带运行时脚本 —— file:// 下要能直接双击打开')
  assert.ok(!/(?:src|href)=["']?(?:https?:)?\/\//i.test(html), '产物不引公网资源')
})

test('doctor 有问题就不出产物', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/extra.md`, '## 孤儿\n')

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'doctor')
  assert.ok(!existsSync(join(dir, 'dist', 'index.html')))
})

test('导入校验拦下时不出产物，--force 放行且把问题带回来', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/prototypes/login-proto/index.html`, '<script type="module" src="app.js"></script>')

  const blocked = buildSite(workspace, byId(workspace, id))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.stage, 'import-check')
  assert.ok(!existsSync(join(dir, 'dist', 'index.html')))

  const forced = buildSite(workspace, byId(workspace, id), { force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.forced, true)
  assert.ok(forced.problems.some((problem) => problem.kind === 'module-script'))
  assert.ok(existsSync(join(dir, 'dist', 'index.html')))
})

test('门户页列出全部产品原型，未构建的标出来且不可点', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'good')
  makeSite(workspace, 'later')

  const { allOk, portal } = buildTargets(workspace, ['good'])
  assert.equal(allOk, true)
  assert.deepEqual(portal, { ready: 1, total: 2 })

  const html = readFileSync(join(workspace, 'dist', 'index.html'), 'utf8')
  assert.match(html, /尚未构建/)
  assert.match(html, /\.\.\/sites\/good\/dist\/index\.html/)
})

test('只要有一个失败，门户页就保持原样', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'good')
  makeSite(workspace, 'broken')
  buildTargets(workspace, ['good'])
  const before = readFileSync(join(workspace, 'dist', 'index.html'), 'utf8')

  write(workspace, 'sites/broken/pages/extra.md', '## 孤儿\n')
  const second = buildTargets(workspace, [])
  assert.equal(second.allOk, false)
  assert.equal(second.portal, null)
  assert.equal(readFileSync(join(workspace, 'dist', 'index.html'), 'utf8'), before, '门户页没被动过')
  assert.ok(existsSync(join(workspace, 'sites', 'good', 'dist', 'index.html')), '成功的那个照样产出')

  rmSync(join(workspace, 'sites', 'broken', 'pages', 'extra.md'))
  const third = buildTargets(workspace, [])
  assert.equal(third.allOk, true)
  assert.deepEqual(third.portal, { ready: 2, total: 2 })
})
