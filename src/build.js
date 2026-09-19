import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')
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

const targets = only.length > 0 ? allSites.filter((site) => only.includes(site.id)) : allSites

/** 构建单个产品原型。返回是否成功。 */
function buildSite(id, dir) {
  const site = loadSite(dir)
  const pages = flattenPages(site)

  const problems = doctor(dir, site)
  if (problems.length > 0) {
    report(`[${id}] doctor 发现清单与磁盘不一致`, problems.map((p) => `[${p.kind}] ${p.message}`))
    return false
  }

  const protoProblems = pages
    .filter((page) => page.type === 'proto')
    .flatMap((page) => checkPrototype(join(dir, 'prototypes', page.id)))
  if (protoProblems.length > 0) {
    report(`[${id}] 原型导入校验发现问题`, protoProblems.map((p) => `[${p.kind}] ${p.message}`))
    if (!force) return false
    console.error(`[${id}] 已按 --force 继续构建。\n`)
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

  console.log(`  ${id}：${pages.length} 个页面 + 概览页 → sites/${id}/dist/`)
  return true
}

console.log('kebab build')
const built = targets.filter(({ id, dir }) => buildSite(id, dir))

if (built.length < targets.length) {
  console.error('\n有产品原型构建失败，门户页未更新。')
  process.exit(1)
}

// 根门户页：列出全部产品原型，未构建的标注出来但不可点
const entries = allSites.map(({ id, dir }) => ({
  id,
  site: loadSite(dir),
  built: existsSync(join(dir, 'dist', 'index.html')),
}))
const portal = join(workspace, 'dist')
rmSync(portal, { recursive: true, force: true })
mkdirSync(portal, { recursive: true })
cpSync(join(here, 'style.css'), join(portal, 'kebab.css'))
writeFileSync(join(portal, 'index.html'), renderPortalPage(entries), 'utf8')

const ready = entries.filter((entry) => entry.built).length
console.log(`  portal：${ready}/${entries.length} 个产品原型可打开 → dist/index.html`)
