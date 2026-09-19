import assert from 'node:assert/strict'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import * as store from '../src/editor/store.js'
import { makeSite, makeWorkspace, tinyPng, tinyPngBase64, write } from './helpers.js'

/* ---------- 编号分配 ---------- */

test('nextCode 取模块内最大流水 +1', () => {
  assert.equal(store.nextCode({ prefix: 'LO', pages: [{ code: 'LO-01' }, { code: 'LO-07' }, { code: 'LO-03' }] }), 'LO-08')
})

test('nextCode：删掉中间号不让后面的补位，删掉末尾号会拿回它', () => {
  // LO-02 已被删，剩下的号不动
  assert.equal(store.nextCode({ prefix: 'LO', pages: [{ code: 'LO-01' }, { code: 'LO-03' }] }), 'LO-04')
  // LO-04 是本模块末尾那个号，删掉之后新页会拿回它
  assert.equal(store.nextCode({ prefix: 'LO', pages: [{ code: 'LO-01' }, { code: 'LO-02' }, { code: 'LO-03' }] }), 'LO-04')
})

test('nextCode 不认别的模块的号', () => {
  assert.equal(store.nextCode({ prefix: 'OR', pages: [{ code: 'LO-09' }] }), 'OR-01')
})

/* ---------- 指纹与陈旧写入 ---------- */

test('指纹只看内容，不看时间戳', (t) => {
  const workspace = makeWorkspace(t)
  const { dir } = makeSite(workspace)
  const before = store.hashTree(dir)

  const file = join(dir, 'pages', 'login-doc.md')
  const later = new Date(Date.now() + 60_000)
  utimesSync(file, later, later)
  assert.equal(store.hashTree(dir), before, '只动时间戳不该算陈旧')

  writeFileSync(file, '## 换了内容\n\n正文\n', 'utf8')
  assert.notEqual(store.hashTree(dir), before)
})

test('指纹覆盖 pages/ 与 assets/ 下的文件', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const before = store.hashTree(dir)

  write(workspace, `sites/${id}/assets/new.png`, 'x')
  const withAsset = store.hashTree(dir)
  assert.notEqual(withAsset, before)

  write(workspace, `sites/${id}/pages/another.md`, '## 另一页\n')
  assert.notEqual(store.hashTree(dir), withAsset)
})

test('指纹不含 prototypes/（原型进库后不再改写）', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const before = store.hashTree(dir)
  write(workspace, `sites/${id}/prototypes/login-proto/extra.js`, 'x')
  assert.equal(store.hashTree(dir), before)
})

test('陈旧指纹的写入一律拒绝', (t) => {
  const workspace = makeWorkspace(t)
  const { id, site } = makeSite(workspace)
  const stale = 'deadbeef'

  assert.throws(() => store.saveDoc(workspace, id, 'login-doc', '改了', stale), store.StaleWrite)
  assert.throws(() => store.saveTree(workspace, id, site, stale), store.StaleWrite)
  assert.throws(() => store.saveAsset(workspace, id, 'a.png', tinyPng, stale), store.StaleWrite)
  assert.throws(() => store.createPage(workspace, id, { moduleId: 'login', pageId: 'x', type: 'doc', title: 'x' }, stale), store.StaleWrite)
  assert.throws(() => store.deletePage(workspace, id, 'login-doc', { withFiles: false }, stale), store.StaleWrite)
})

/* ---------- 页面与模块 ---------- */

test('createPage 给 doc 页落空文件、给 proto 页建目录，并分配下一个号', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const revision = store.hashTree(dir)

  const after = store.createPage(workspace, id, { moduleId: 'login', pageId: 'login-doc-2', type: 'doc', title: '第二篇' }, revision)
  assert.equal(after.site.modules[0].pages.at(-1).code, 'LO-03')
  assert.equal(readFileSync(join(dir, 'pages', 'login-doc-2.md'), 'utf8'), '')

  const proto = store.createPage(workspace, id, { moduleId: 'login', pageId: 'login-proto-2', type: 'proto', title: '第二版原型' }, after.revision)
  assert.equal(proto.site.modules[0].pages.at(-1).code, 'LO-04')
  assert.ok(existsSync(join(dir, 'prototypes', 'login-proto-2')))
  // 入口还没放进去，doctor 如实报出来
  assert.equal(proto.problems.filter((problem) => problem.kind === 'dangling').length, 1)
})

test('createPage 拦住不合规的 id、重复的 id、未知模块与非法类型', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const revision = store.hashTree(dir)
  const bad = (payload) => assert.throws(() => store.createPage(workspace, id, payload, revision), store.BadRequest)

  bad({ moduleId: 'login', pageId: 'Bad Id', type: 'doc', title: 'x' })
  bad({ moduleId: 'login', pageId: 'login-doc', type: 'doc', title: 'x' })
  bad({ moduleId: 'nope', pageId: 'fresh', type: 'doc', title: 'x' })
  bad({ moduleId: 'login', pageId: 'fresh', type: 'page', title: 'x' })
})

test('deletePage 的 withFiles 决定要不要动磁盘', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)

  const kept = store.deletePage(workspace, id, 'login-doc', { withFiles: false }, store.hashTree(dir))
  assert.ok(existsSync(join(dir, 'pages', 'login-doc.md')), '不勾选时正文文件留在原地')
  assert.equal(kept.problems.filter((problem) => problem.kind === 'orphan').length, 1)

  const gone = store.deletePage(workspace, id, 'login-proto', { withFiles: true }, kept.revision)
  assert.ok(!existsSync(join(dir, 'prototypes', 'login-proto')), '勾选时连目录一起删')
  assert.equal(gone.problems.length, 1, '剩下的孤儿文件仍如实报出')
})

test('createModule 把前缀转成大写，id 与前缀都要合规', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)

  const after = store.createModule(workspace, id, { moduleId: 'order', title: '订单', prefix: 'or' }, store.hashTree(dir))
  assert.equal(after.site.modules[1].prefix, 'OR')
  assert.deepEqual(after.site.modules[1].pages, [])

  assert.throws(() => store.createModule(workspace, id, { moduleId: 'order', title: 'x', prefix: 'OR' }, after.revision), store.BadRequest)
  assert.throws(() => store.createModule(workspace, id, { moduleId: 'Bad', title: 'x', prefix: 'OR' }, after.revision), store.BadRequest)
  assert.throws(() => store.createModule(workspace, id, { moduleId: 'fresh', title: 'x', prefix: '  ' }, after.revision), store.BadRequest)
})

test('saveTree 拦住重复的 page id 与 code，并保持字段顺序', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir, site } = makeSite(workspace)

  const duplicate = structuredClone(site)
  duplicate.modules[0].pages[1].code = 'LO-01'
  assert.throws(() => store.saveTree(workspace, id, duplicate, store.hashTree(dir)), store.BadRequest)

  const shuffled = structuredClone(site)
  shuffled.modules[0].pages[0] = { title: '标题被挪到前面', type: 'doc', code: 'LO-01', id: 'login-doc' }
  store.saveTree(workspace, id, shuffled, store.hashTree(dir))
  const onDisk = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'))
  assert.deepEqual(Object.keys(onDisk.modules[0].pages[0]), ['id', 'code', 'type', 'title'])
})

/* ---------- orphan 的两个出口 ---------- */

test('importOrphan 只改清单，磁盘上的文件原地不动', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/unfiled.md`, '## 孤儿\n\n正文\n')

  const after = store.importOrphan(workspace, id, { path: 'pages/unfiled.md', moduleId: 'login', title: '收编进来的' }, store.hashTree(dir))
  const page = after.site.modules[0].pages.at(-1)
  assert.equal(page.id, 'unfiled')
  assert.equal(page.type, 'doc')
  assert.equal(page.code, 'LO-03')
  assert.equal(readFileSync(join(dir, 'pages', 'unfiled.md'), 'utf8'), '## 孤儿\n\n正文\n')
  assert.equal(after.problems.filter((problem) => problem.kind === 'orphan').length, 0)
})

test(' importOrphan 拒绝越界路径、已被引用的 id、不合规的 id', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/extra.md`, 'x')
  const revision = store.hashTree(dir)
  const bad = (path) => assert.throws(() => store.importOrphan(workspace, id, { path, moduleId: 'login', title: 'x' }, revision), store.BadRequest)

  bad('../site.json')
  bad('assets/多余.md')
  bad('pages/login-doc.md')
  bad('pages/Bad Name.md')
})

test('deleteOrphan 删掉磁盘上的文件，但只认 pages/ 与 prototypes/', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/prototypes/leftover/index.html`, '<!doctype html>')
  write(workspace, `sites/${id}/assets/pic.png`, 'x')

  assert.throws(() => store.deleteOrphan(workspace, id, 'assets/pic.png', store.hashTree(dir)), store.BadRequest)
  const after = store.deleteOrphan(workspace, id, 'prototypes/leftover', store.hashTree(dir))
  assert.ok(!existsSync(join(dir, 'prototypes', 'leftover')))
  assert.equal(after.problems.length, 0)
})

/* ---------- 素材与正文 ---------- */

test('saveAsset 校验类型与空文件，重名让路，中文名保留', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)

  const first = store.saveAsset(workspace, id, '登录页截图.png', tinyPng, store.hashTree(dir))
  assert.equal(first.path, 'assets/登录页截图.png')
  assert.ok(readFileSync(join(dir, first.path)).equals(tinyPng))

  const second = store.saveAsset(workspace, id, '登录页截图.png', tinyPng, first.revision)
  assert.equal(second.path, 'assets/登录页截图-2.png')

  assert.throws(() => store.saveAsset(workspace, id, 'evil.exe', tinyPng, second.revision), store.BadRequest)
  assert.throws(() => store.saveAsset(workspace, id, 'empty.png', Buffer.alloc(0), second.revision), store.BadRequest)
  assert.throws(() => store.saveAsset(workspace, id, '无名', tinyPng, second.revision), store.BadRequest)
})

test('saveDoc 把内联 base64 图片搬进 assets/，其它 data: 不动', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)

  const text = [
    '## 探针',
    '',
    `![第一张](data:image/png;base64,${tinyPngBase64})`,
    '',
    `![第二张](data:image/png;base64,${tinyPngBase64})`,
    '',
    `![不支持的](data:image/bmp;base64,${tinyPngBase64})`,
    '',
    '![非图片](data:text/plain;base64,aGk=)',
    '',
    '结尾',
  ].join('\n')

  const after = store.saveDoc(workspace, id, 'login-doc', text, store.hashTree(dir))
  assert.equal(after.rescued, 2, '只搬能认出来的图片，bmp 与 text/plain 不算')

  const onDisk = readFileSync(join(dir, 'pages', 'login-doc.md'), 'utf8')
  assert.ok(!onDisk.includes('data:image/png;base64'))
  assert.ok(onDisk.includes('![第一张](assets/pasted.png)'))
  assert.ok(onDisk.includes('![第二张](assets/pasted-2.png)'))
  assert.ok(onDisk.includes('data:image/bmp;base64'), '不支持的图片类型原样留着')
  assert.ok(onDisk.includes('data:text/plain;base64'), '非图片的 data: 原样留着')
  assert.ok(onDisk.startsWith('## 探针'))
  assert.ok(onDisk.trimEnd().endsWith('结尾'))
  assert.ok(readFileSync(join(dir, 'assets', 'pasted.png')).equals(tinyPng))
})

test('saveDoc 对普通正文不动一个字节，也不报搬运', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const text = '## 标题\n\n![图](assets/pic.png)\n\n正文\n'
  const after = store.saveDoc(workspace, id, 'login-doc', text, store.hashTree(dir))
  assert.equal(after.rescued, 0)
  assert.equal(readFileSync(join(dir, 'pages', 'login-doc.md'), 'utf8'), text)
})

test('readDoc 只接受 doc 页，且对缺失文件返回 null', (t) => {
  const workspace = makeWorkspace(t)
  const { id, site } = makeSite(workspace)

  assert.match(store.readDoc(workspace, id, 'login-doc').text, /调整背景/)
  assert.throws(() => store.readDoc(workspace, id, 'login-proto'), store.BadRequest)
  assert.throws(() => store.readDoc(workspace, id, '没有这一页'), store.BadRequest)
  assert.equal(store.stateOf(workspace, id).site.site.title, site.site.title)
})

test('resolveSite 拒绝不存在的产品原型', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'demo')
  assert.throws(() => store.resolveSite(workspace, 'nope'), store.BadRequest)
})

test('page id 只收小写英文数字与短横线，中文名会被拒', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  const revision = store.hashTree(dir)

  assert.throws(
    () => store.createPage(workspace, id, { moduleId: 'login', pageId: '登录页', type: 'doc', title: 'x' }, revision),
    store.BadRequest,
  )
  // 孤儿文件若是中文名，也导不进来 —— 只能改名或删掉
  assert.throws(
    () => store.importOrphan(workspace, id, { path: 'pages/登录页.md', moduleId: 'login', title: 'x' }, revision),
    store.BadRequest,
  )
})
