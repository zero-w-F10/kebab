import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { createEditorServer } from '../src/editor/server.js'
import { makeSite, makeWorkspace, tinyPng, write } from './helpers.js'

/**
 * 服务端接口。这里在同一个进程里 listen(0) 打自己的服务 —— 起不了子进程，
 * 也正是为此把 server.js 抽成了工厂。
 */
async function serve(t, { site = 'demo' } = {}) {
  const workspace = makeWorkspace(t)
  makeSite(workspace, site)
  // 前端产物不入 git，造一份假的，让静态路由也有得测
  write(workspace, 'ui/index.html', '<!doctype html><div id="app"></div>')
  write(workspace, 'ui/dist/ui.js', 'export const a = 1\n')
  write(workspace, 'ui/dist/ui.css', '.a{}\n')

  const server = createEditorServer({ workspace, site, uiDir: join(workspace, 'ui') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())

  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const asJson = async (response) => ({ status: response.status, body: await response.json().catch(() => null) })

  return {
    workspace,
    dir: join(workspace, 'sites', site),
    /** 发未规范化的原始路径：fetch 会把 %2e%2e 抹平，越界请求得自己发。 */
    rawStatus: (path) => new Promise((done, fail) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
        response.resume()
        done(response.statusCode)
      })
      request.on('error', fail)
      request.end()
    }),
    fetch: (path, init) => fetch(base + path, init),
    get: async (path) => asJson(await fetch(base + path)),
    post: async (path, payload) => asJson(await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })),
    upload: async (name, buffer, revision) => asJson(await fetch(
      `${base}/api/asset/upload?name=${encodeURIComponent(name)}&baseRevision=${revision}`,
      { method: 'POST', body: buffer },
    )),
  }
}

test('GET /api/state 给出站点清单、指纹与 doctor 结果', async (t) => {
  const api = await serve(t)
  const { status, body } = await api.get('/api/state')
  assert.equal(status, 200)
  assert.equal(body.site.site.title, '示例产品原型')
  assert.equal(typeof body.revision, 'string')
  assert.deepEqual(body.problems, [])
  assert.deepEqual(body.sites.map((entry) => entry.id), ['demo'])
})

test('编辑器页面与前端资源由服务提供，其余路径 404', async (t) => {
  const api = await serve(t)
  assert.equal((await api.fetch('/')).status, 200)
  assert.equal((await api.fetch('/ui.js')).status, 200)
  assert.equal((await api.fetch('/ui.css')).status, 200)
  assert.equal((await api.fetch('/没这个')).status, 404)
})

test('新建页面 → 分配编号 → 保存正文 → 指纹前进', async (t) => {
  const api = await serve(t)
  const state = (await api.get('/api/state')).body

  const created = await api.post('/api/page/create', { moduleId: 'login', pageId: 'fresh', type: 'doc', title: '新页', baseRevision: state.revision })
  assert.equal(created.status, 200)
  assert.equal(created.body.site.modules[0].pages.at(-1).code, 'LO-03')
  assert.ok(existsSync(join(api.dir, 'pages', 'fresh.md')))

  const saved = await api.post('/api/doc/save', { id: 'fresh', text: '## 一\n', baseRevision: created.body.revision })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.rescued, 0)
  assert.equal(readFileSync(join(api.dir, 'pages', 'fresh.md'), 'utf8'), '## 一\n')
  assert.notEqual(saved.body.revision, created.body.revision)
})

test('GET /api/doc 读正文', async (t) => {
  const api = await serve(t)
  const { status, body } = await api.get('/api/doc?id=login-doc')
  assert.equal(status, 200)
  assert.match(body.text, /调整背景/)
  assert.equal((await api.get('/api/doc?id=login-proto')).status, 400)
  assert.equal((await api.get('/api/doc?id=不存在')).status, 400)
})

test('磁盘被外部改动后，旧指纹的保存被 409 拦下且不落盘', async (t) => {
  const api = await serve(t)
  const state = (await api.get('/api/state')).body
  write(api.workspace, 'sites/demo/pages/login-doc.md', '## 外部改的\n')

  const stale = await api.post('/api/doc/save', { id: 'login-doc', text: '## 编辑器写的\n', baseRevision: state.revision })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.stale, true)
  assert.equal(typeof stale.body.revision, 'string')
  assert.match(readFileSync(join(api.dir, 'pages', 'login-doc.md'), 'utf8'), /外部改的/)
})

test('清单里 code 撞车被 400 拦下', async (t) => {
  const api = await serve(t)
  const state = (await api.get('/api/state')).body
  const tree = structuredClone(state.site)
  tree.modules[0].pages[1].code = 'LO-01'

  const response = await api.post('/api/tree', { tree, baseRevision: state.revision })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /code 重复/)
})

test('上传素材：二进制体、assets/ 路径、重名让路、旧指纹 409', async (t) => {
  const api = await serve(t)
  const state = (await api.get('/api/state')).body

  const first = await api.upload('登录页截图.png', tinyPng, state.revision)
  assert.equal(first.status, 200)
  assert.equal(first.body.path, 'assets/登录页截图.png')
  assert.ok(readFileSync(join(api.dir, first.body.path)).equals(tinyPng))

  const again = await api.upload('登录页截图.png', tinyPng, first.body.revision)
  assert.equal(again.body.path, 'assets/登录页截图-2.png')
  assert.equal((await api.upload('evil.exe', tinyPng, again.body.revision)).status, 400)
  assert.equal((await api.upload('stale.png', tinyPng, 'deadbeef')).status, 409)
})

test('原型与素材可以读，越界被挡', async (t) => {
  const api = await serve(t)
  assert.equal((await api.fetch('/proto/login-proto/index.html')).status, 200)
  assert.equal((await api.fetch('/proto/没有这个/index.html')).status, 404)

  // 越界的原始路径：服务端解码后必须挡住
  // 明文的 .. 会被 URL 解析先消掉，这类请求根本走不到站点目录
  assert.notEqual(await api.rawStatus('/proto/../../site.json'), 200)
  // 编码过的 ../ 能穿过 URL 解析，靠服务端解码后的越界检查挡住
  assert.equal(await api.rawStatus('/assets/%2e%2e%2f%2e%2e%2fsite.json'), 400)
})

test('未知接口 404，坏 JSON 400', async (t) => {
  const api = await serve(t)
  assert.equal((await api.get('/api/没有这个接口')).status, 404)

  const bad = await api.fetch('/api/tree', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{这不是 JSON',
  })
  assert.equal(bad.status, 400)
})

test('orphan 的导入与删除走 HTTP 也是通的', async (t) => {
  const api = await serve(t)
  write(api.workspace, 'sites/demo/pages/orphan-page.md', '## 孤儿\n')

  const state = (await api.get('/api/state')).body
  assert.equal(state.problems.filter((problem) => problem.kind === 'orphan').length, 1)

  const imported = await api.post('/api/orphan/import', { path: 'pages/orphan-page.md', moduleId: 'login', title: '收编', baseRevision: state.revision })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.problems.filter((problem) => problem.kind === 'orphan').length, 0)

  const removed = await api.post('/api/page/delete', { id: 'orphan-page', withFiles: true, baseRevision: imported.body.revision })
  assert.equal(removed.status, 200)
  assert.ok(!existsSync(join(api.dir, 'pages', '多出来的.md')))
})

test('POST /api/build 与 npm run build 同路，产物能经 /build/ 预览', async (t) => {
  const api = await serve(t)

  const built = await api.post('/api/build', {})
  assert.equal(built.status, 200)
  assert.equal(built.body.ok, true)
  assert.equal(built.body.pages, 2)
  assert.equal(built.body.forced, false)

  assert.equal((await api.fetch('/build/index.html')).status, 200)
  assert.equal((await api.fetch('/build/login-doc.html')).status, 200)
  assert.equal((await api.fetch('/build/没有这个.html')).status, 404)
  assert.equal(await api.rawStatus('/build/%2e%2e%2f%2e%2e%2fsite.json'), 400)
})

test('构建失败的两种原因都如实报回来，force 才放行', async (t) => {
  const api = await serve(t)

  // 一：清单与磁盘不一致
  write(api.workspace, 'sites/demo/pages/extra.md', '## 孤儿\n')
  const broken = await api.post('/api/build', {})
  assert.equal(broken.body.ok, false)
  assert.equal(broken.body.stage, 'doctor')
  assert.ok(broken.body.problems.some((problem) => problem.kind === 'orphan'))

  // 换成原型里的 module script
  rmSync(join(api.dir, 'pages', 'extra.md'))
  write(api.workspace, 'sites/demo/prototypes/login-proto/index.html', '<script type="module" src="a.js"></script>')

  const blocked = await api.post('/api/build', {})
  assert.equal(blocked.body.ok, false)
  assert.equal(blocked.body.stage, 'import-check')

  const forced = await api.post('/api/build', { force: true })
  assert.equal(forced.body.ok, true)
  assert.equal(forced.body.forced, true)
  assert.equal((await api.fetch('/build/index.html')).status, 200)
})
