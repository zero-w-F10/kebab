import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { listSites } from '../doctor.js'
import { BadRequest, StaleWrite, siteSummaries, stateOf } from './store.js'
import * as store from './store.js'

/**
 * 编辑器的本地服务。只用 Node 内置的 http，不引入框架 ——
 * 它借宿在工具仓库里，不该为了几个接口把依赖面撑开。
 *
 * 只监听 127.0.0.1：这是给自己用的工具，不进局域网。
 */

const here = dirname(fileURLToPath(import.meta.url))
const defaultUiDir = join(here, 'ui')

const MAX_BODY = 32 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const json = (res, code, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('404')
}

const serveFile = (res, file) => {
  if (!existsSync(file) || statSync(file).isDirectory()) return notFound(res)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  res.end(readFileSync(file))
}

/** 只在站点目录内取文件，挡住 ../ 之类的越界路径。 */
const inside = (root, target) => {
  const full = resolve(target)
  const base = resolve(root)
  return full === base || full.startsWith(base + sep)
}

function readJson(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new BadRequest('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return done({})
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        fail(new BadRequest('请求体不是合法 JSON'))
      }
    })
    req.on('error', fail)
  })
}

/** 图片这类二进制上传：不解析，直接收成 Buffer。 */
function readBinary(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new BadRequest('文件过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

/**
 * 造一台编辑器服务（还没 listen）。`site` 是它认准的产品原型 —— 编辑器一次只服务一个。
 * 抽成工厂是为了让测试能在同一个进程里 listen(0) 打它：这个环境起不了子进程。
 */
export function createEditorServer({ workspace, site, uiDir = defaultUiDir }) {
  const distDir = join(uiDir, 'dist')

  function handleApi(req, res, url) {
    const key = `${req.method} ${url.pathname}`

    // 上传的体是二进制，绕过 JSON 解析
    if (key === 'POST /api/asset/upload') {
      return readBinary(req).then((buffer) => json(res, 200, store.saveAsset(
        workspace,
        site,
        url.searchParams.get('name'),
        buffer,
        url.searchParams.get('baseRevision'),
      )))
    }

    return readJson(req).then((body) => {
      switch (key) {
        case 'GET /api/state':
          return json(res, 200, { sites: siteSummaries(workspace), ...stateOf(workspace, site) })
        case 'GET /api/doc':
          return json(res, 200, store.readDoc(workspace, site, url.searchParams.get('id')))
        case 'POST /api/tree':
          return json(res, 200, store.saveTree(workspace, site, body.tree, body.baseRevision))
        case 'POST /api/page/create':
          return json(res, 200, store.createPage(workspace, site, body, body.baseRevision))
        case 'POST /api/page/delete':
          return json(res, 200, store.deletePage(workspace, site, body.id, body, body.baseRevision))
        case 'POST /api/module/create':
          return json(res, 200, store.createModule(workspace, site, body, body.baseRevision))
        case 'POST /api/module/delete':
          return json(res, 200, store.deleteModule(workspace, site, body.id, body, body.baseRevision))
        case 'POST /api/doc/save':
          return json(res, 200, store.saveDoc(workspace, site, body.id, body.text, body.baseRevision))
        case 'POST /api/orphan/import':
          return json(res, 200, store.importOrphan(workspace, site, body, body.baseRevision))
        case 'POST /api/orphan/delete':
          return json(res, 200, store.deleteOrphan(workspace, site, body.path, body.baseRevision))
        default:
          return json(res, 404, { error: `没有这个接口：${key}` })
      }
    })
  }

  async function handle(req, res, url) {
    const pathname = decodeURIComponent(url.pathname)

    // 编辑器自身的静态资源
    if (req.method === 'GET' && pathname === '/') return serveFile(res, join(uiDir, 'index.html'))
    if (req.method === 'GET' && pathname === '/ui.js') return serveFile(res, join(distDir, 'ui.js'))
    if (req.method === 'GET' && pathname === '/ui.css') return serveFile(res, join(distDir, 'ui.css'))

    // 原型与素材。编辑器一次只服务一个站点，所以路径里不带 site id：
    // 正文里写的是 assets/x.png（相对站点根），在编辑器页面上正好落到这里。
    const asset = /^\/(proto|assets)\/(.+)$/.exec(pathname)
    if (req.method === 'GET' && asset) {
      const [, kind, rest] = asset
      const dir = store.resolveSite(workspace, site)
      const root = join(dir, kind === 'proto' ? 'prototypes' : 'assets')
      const file = join(root, rest)
      if (!inside(root, file)) throw new BadRequest(`路径越界：${pathname}`)
      return serveFile(res, file)
    }

    if (pathname.startsWith('/api/')) return handleApi(req, res, url)

    return notFound(res)
  }

  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    Promise.resolve(handle(req, res, url)).catch((error) => {
      if (error instanceof StaleWrite) {
        return json(res, 409, { error: error.message, revision: error.revision, stale: true })
      }
      if (error instanceof BadRequest) return json(res, 400, { error: error.message })
      console.error(error)
      if (!res.headersSent) json(res, 500, { error: error.message ?? '服务端出错' })
    })
  })
}

/* ---------- 命令行入口 ---------- */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const workspace = join(here, '..', '..')
  const uiDir = defaultUiDir
  const argv = process.argv.slice(2)
  const argOf = (name) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const sites = listSites(workspace)
  if (sites.length === 0) {
    console.error(`kebab editor：${join(workspace, 'sites')} 下没有任何产品原型。`)
    console.error('先按 docs/authoring.md 建一个，再启动编辑器。')
    process.exit(1)
  }

  const requested = argOf('site')
  if (requested && !sites.some((entry) => entry.id === requested)) {
    console.error(`kebab editor：没有这个产品原型：${requested}`)
    console.error(`可用的有：${sites.map((entry) => entry.id).join('、')}`)
    process.exit(1)
  }

  const site = requested ?? (sites.length === 1 ? sites[0].id : null)
  if (!site) {
    console.error('kebab editor：sites/ 下有多个产品原型，用 --site 指定一个。')
    console.error(`可用的有：${sites.map((entry) => entry.id).join('、')}`)
    process.exit(1)
  }

  if (!existsSync(join(uiDir, 'dist', 'ui.js'))) {
    console.error('kebab editor：编辑器前端还没构建，先跑 npm run editor:build。')
    process.exit(1)
  }

  const server = createEditorServer({ workspace, site, uiDir })
  const start = Number(argOf('port') ?? 4173)

  function listen(port, attempts = 20) {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && attempts > 0) {
        listen(port + 1, attempts - 1)
        return
      }
      console.error(`kebab editor：监听失败 —— ${error.message}`)
      process.exit(1)
    })
    server.listen(port, '127.0.0.1', () => {
      const entry = siteSummaries(workspace).find((item) => item.id === site)
      console.log('kebab editor')
      console.log(`  站点：${site} — ${entry?.title ?? ''}`)
      console.log(`  打开：http://127.0.0.1:${port}/  （Ctrl+C 退出）`)
    })
  }

  listen(start)
}
