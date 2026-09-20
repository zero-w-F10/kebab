import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { doctor, flattenPages, listSites } from '../src/doctor.js'
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
  assert.match(problems[0].message, /登录页改版说明/)
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

test('assets/ 里的文件不算 orphan，改按正文引用核对', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/assets/pic.png`, 'x')

  const problems = doctor(dir, site)
  assert.equal(problems.filter((problem) => problem.kind === 'orphan').length, 0)
  assert.deepEqual(problems.map((problem) => [problem.kind, problem.path]), [['unused-asset', 'assets/pic.png']])
})

test('正文引用到的素材不报闲置，编码过的中文名也算', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/assets/pic.png`, 'x')
  write(workspace, `sites/${id}/assets/另一张.png`, 'x')
  write(workspace, `sites/${id}/pages/login-doc.md`,
    '## 一\n\n![原样](assets/pic.png)\n\n![编码](assets/%E5%8F%A6%E4%B8%80%E5%BC%A0.png)\n')

  assert.deepEqual(doctor(dir, site).filter((problem) => problem.kind === 'unused-asset'), [])
})

test('未引用的素材报闲置，带 path 供编辑器删', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/assets/used.png`, 'x')
  write(workspace, `sites/${id}/assets/left.png`, 'x')
  write(workspace, `sites/${id}/assets/sub/deep.png`, 'x')
  write(workspace, `sites/${id}/pages/login-doc.md`, '## 一\n\n![图](assets/used.png)\n')

  const unused = doctor(dir, site).filter((problem) => problem.kind === 'unused-asset')
  assert.deepEqual(unused.map((problem) => problem.path), ['assets/left.png', 'assets/sub/deep.png'])
})

test('点开头的文件不算 orphan（编辑器的临时文件）', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/.login-doc.md.swp`, 'x')
  assert.deepEqual(doctor(dir, site), [])
})

test('page id 重复 → duplicate', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = makeSite(workspace, 'demo', (draft) => {
    draft.modules[0].pages.push({ id: 'login-doc', type: 'doc', title: '撞 id 的' })
    return draft
  })

  const problems = doctor(dir, site)
  assert.equal(problems.filter((problem) => problem.kind === 'duplicate').length, 1)
  assert.match(problems[0].message, /id 重复/)
})

test('标题可以重复，它不是身份', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = makeSite(workspace, 'demo', (draft) => {
    draft.modules[0].pages[1].title = '登录页改版说明'
    return draft
  })

  assert.deepEqual(doctor(dir, site), [])
})

test('listSites 只认带 site.json 的目录，跳过点开头的，按名字排序', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'beta')
  makeSite(workspace, 'alpha')
  mkdirSync(join(workspace, 'sites', 'no-manifest'))
  write(workspace, 'sites/.hidden/site.json', '{}')

  assert.deepEqual(listSites(workspace).map((entry) => entry.id), ['alpha', 'beta'])
})

/* ---------- 页面嵌套 ---------- */

/** 给 demo 的第一页挂上下级（连孙级），磁盘上的正文也落好。 */
const nestSite = (workspace) => makeSite(workspace, 'demo', (draft) => {
  draft.modules[0].pages[0].children = [
    {
      id: 'login-doc-a1',
      type: 'doc',
      title: 'A 的补充说明',
      children: [{ id: 'login-doc-a1-1', type: 'doc', title: '再往下一条' }],
    },
  ]
  return draft
})

test('摊平按前序：父级排在下级前面，逐层展开', (t) => {
  const workspace = makeWorkspace(t)
  const { id, site } = nestSite(workspace)

  assert.deepEqual(
    flattenPages(site).map((page) => page.id),
    ['login-doc', 'login-doc-a1', 'login-doc-a1-1', 'login-proto'],
  )
  assert.equal(flattenPages(site)[0].module.id, 'login', '每一项都带着所属 module')
})

test('下级与孙级的正文缺了照样报 dangling', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = nestSite(workspace)
  write(workspace, `sites/${id}/pages/login-doc-a1.md`, '## 一\n')
  write(workspace, `sites/${id}/pages/login-doc-a1-1.md`, '## 一\n')
  assert.deepEqual(doctor(dir, site), [])

  rmSync(join(dir, 'pages', 'login-doc-a1-1.md'))
  const problems = doctor(dir, site)
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /再往下一条/)
  assert.match(problems[0].message, /pages\/login-doc-a1-1\.md/)
})

test('嵌在不同层级里的 page id 撞车也算重复', (t) => {
  const workspace = makeWorkspace(t)
  const { dir, site } = nestSite(workspace)
  site.modules[0].pages[0].children[0].id = 'login-proto'

  const duplicates = doctor(dir, site).filter((problem) => problem.kind === 'duplicate')
  assert.equal(duplicates.length, 1)
  assert.match(duplicates[0].message, /id 重复/)
})
