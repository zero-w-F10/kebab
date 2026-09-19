import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { contentPathOf, doctor, flattenPages, listSites, loadSite } from './doctor.js'
import { checkPrototype } from './import-check.js'
import {
  renderDocBody,
  renderOverview,
  renderPortalPage,
  renderProtoBody,
  renderShell,
} from './layout.js'
import { createRenderer } from './render.js'

/**
 * 构建器。既能当命令行用（npm run build），也能被编辑器导入 ——
 * 编辑器里的「构建」按钮和终端跑的是同一条代码路径，两处不会各自漂移。
 */

const here = dirname(fileURLToPath(import.meta.url))
const defaultWorkspace = join(here, '..')

/**
 * 构建一个产品原型：先核对清单与磁盘，再扫原型，最后铺产物。
 * 不打印任何东西，只把结果交回去，由调用方决定怎么说。
 */
export function buildSite(workspace, { id, dir }, { force = false } = {}) {
  const site = loadSite(dir)
  const pages = flattenPages(site)

  const problems = doctor(dir, site)
  if (problems.length > 0) return { id, ok: false, stage: 'doctor', problems }

  const protoProblems = pages
    .filter((page) => page.type === 'proto')
    .flatMap((page) => checkPrototype(join(dir, 'prototypes', page.id)))
  if (protoProblems.length > 0 && !force) {
    return { id, ok: false, stage: 'import-check', problems: protoProblems }
  }

  const dist = join(dir, 'dist')
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })

  for (const sub of ['assets', 'prototypes']) {
    const from = join(dir, sub)
    if (existsSync(from)) cpSync(from, join(dist, sub), { recursive: true })
  }
  cpSync(join(here, 'style.css'), join(dist, 'kebab.css'))

  for (const page of pages) {
    const body = page.type === 'proto'
      ? renderProtoBody(page)
      : renderDocBody(page, createRenderer(page.id).render(readFileSync(contentPathOf(dir, page), 'utf8')))
    writeFileSync(join(dist, `${page.id}.html`), renderShell(site, page, body), 'utf8')
  }

  writeFileSync(
    join(dist, 'index.html'),
    renderShell(site, { id: '', title: site.site?.title ?? '概览' }, renderOverview(site)),
    'utf8',
  )

  return {
    id,
    ok: true,
    pages: pages.length,
    // 按 --force 放行时，问题仍带出来给使用者过目
    forced: protoProblems.length > 0,
    problems: protoProblems,
    dist: `sites/${id}/dist`,
  }
}

/** 根门户页：列出全部产品原型，未构建的标注出来但不可点。 */
export function buildPortal(workspace, sites) {
  const entries = sites.map(({ id, dir }) => ({
    id,
    site: loadSite(dir),
    built: existsSync(join(dir, 'dist', 'index.html')),
  }))

  const portal = join(workspace, 'dist')
  rmSync(portal, { recursive: true, force: true })
  mkdirSync(portal, { recursive: true })
  cpSync(join(here, 'style.css'), join(portal, 'kebab.css'))
  writeFileSync(join(portal, 'index.html'), renderPortalPage(entries), 'utf8')

  return { ready: entries.filter((entry) => entry.built).length, total: entries.length }
}

/** 构建一批产品原型。只要有一个失败，门户页就不动。 */
export function buildTargets(workspace, ids, { force = false } = {}) {
  const sites = listSites(workspace)
  const targets = ids?.length ? sites.filter((site) => ids.includes(site.id)) : sites
  const results = targets.map((entry) => buildSite(workspace, entry, { force }))
  const allOk = results.every((result) => result.ok)

  return { results, allOk, portal: allOk ? buildPortal(workspace, sites) : null }
}

/* ---------- 命令行入口 ---------- */

const describe = (problem) => `[${problem.kind}] ${problem.message}`
  + (problem.hint ? `\n      → ${problem.hint}` : '')

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const workspace = defaultWorkspace
  const force = process.argv.includes('--force')
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))

  const report = (heading, lines) => {
    console.error(`\n${heading}`)
    for (const line of lines) console.error(`  ${line}`)
    console.error('')
  }

  const allSites = listSites(workspace)
  if (allSites.length === 0) {
    report('构建中止：sites/ 下没有任何产品原型', [
      `在 ${join(workspace, 'sites')} 下建一个目录，放入 site.json、pages/、assets/`,
    ])
    process.exit(1)
  }

  const unknown = only.filter((id) => !allSites.some((site) => site.id === id))
  if (unknown.length > 0) {
    report('构建中止：指定的产品原型不存在', [
      unknown.join('、'),
      `可用的有：${allSites.map((site) => site.id).join('、')}`,
    ])
    process.exit(1)
  }

  console.log('kebab build')
  const { results, allOk, portal } = buildTargets(workspace, only, { force })

  for (const result of results) {
    if (result.ok) {
      const suffix = result.forced ? '（按 --force 放行）' : ''
      console.log(`  ${result.id}：${result.pages} 个页面 + 概览页 → sites/${result.id}/dist/${suffix}`)
    } else {
      const heading = result.stage === 'doctor'
        ? `[${result.id}] doctor 发现清单与磁盘不一致`
        : `[${result.id}] 原型导入校验发现问题`
      report(heading, result.problems.map(describe))
    }
  }

  if (!allOk) {
    console.error('\n有产品原型构建失败，门户页未更新。')
    process.exit(1)
  }

  console.log(`  portal：${portal.ready}/${portal.total} 个产品原型可打开 → dist/index.html`)
}
