import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 读 site.json —— 一个产品原型的导航树的唯一真相。 */
export function loadSite(dir) {
  return JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'))
}

/**
 * 发现 sites/ 下的全部产品原型。目录名就是 site id。
 * 目录本身就是真相，不额外维护一份索引。
 */
export function listSites(workspace) {
  const base = join(workspace, 'sites')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => existsSync(join(base, entry.name, 'site.json')))
    .map((entry) => ({ id: entry.name, dir: join(base, entry.name) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 把模块树摊平成页面列表，每项带着所属模块。 */
export function flattenPages(site) {
  return (site.modules ?? []).flatMap((mod) =>
    (mod.pages ?? []).map((page) => ({ ...page, module: mod })),
  )
}

export const entryOf = (page) => page.entry ?? 'index.html'

/** 页面在磁盘上的落点：doc 页是单个 md，proto 页是整个目录。 */
export function contentPathOf(dir, page) {
  return page.type === 'proto'
    ? join(dir, 'prototypes', page.id)
    : join(dir, 'pages', `${page.id}.md`)
}

/**
 * 一致性核对：找出清单与磁盘之间的失配。
 * 返回问题列表，空列表表示一致。
 */
export function doctor(dir, site) {
  const problems = []
  const pages = flattenPages(site)

  const seen = { id: new Map(), code: new Map() }
  for (const page of pages) {
    for (const key of ['id', 'code']) {
      const value = page[key]
      const first = seen[key].get(value)
      if (first) {
        problems.push({
          kind: 'duplicate',
          message: `${key} 重复：${value}（${first.title} 与 ${page.title}）`,
        })
      } else {
        seen[key].set(value, page)
      }
    }
  }

  for (const page of pages) {
    if (page.type === 'proto') {
      const entry = join(contentPathOf(dir, page), entryOf(page))
      if (!existsSync(entry)) {
        problems.push({
          kind: 'dangling',
          message: `${page.code} ${page.title}：找不到原型入口 prototypes/${page.id}/${entryOf(page)}`,
        })
      }
    } else if (!existsSync(contentPathOf(dir, page))) {
      problems.push({
        kind: 'dangling',
        message: `${page.code} ${page.title}：找不到 pages/${page.id}.md`,
      })
    }
  }

  const declared = new Set(pages.map((page) => page.id))
  for (const sub of ['pages', 'prototypes']) {
    const abs = join(dir, sub)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue // 编辑器临时文件与系统文件，不是内容
      const id = name.replace(/\.[^.]+$/, '')
      if (!declared.has(id)) {
        problems.push({
          kind: 'orphan',
          message: `孤儿文件：${sub}/${name} 没有被清单引用`,
        })
      }
    }
  }

  return problems
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const workspace = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sites = listSites(workspace)

  if (sites.length === 0) {
    console.error(`kebab doctor：sites/ 下没有找到任何产品原型。`)
    process.exitCode = 1
  } else {
    let total = 0
    for (const { id, dir } of sites) {
      const problems = doctor(dir, loadSite(dir))
      total += problems.length
      if (problems.length === 0) {
        console.log(`  ✓ ${id}：清单与磁盘一致`)
      } else {
        console.log(`  ✗ ${id}：${problems.length} 个问题`)
        for (const problem of problems) console.error(`      [${problem.kind}] ${problem.message}`)
      }
    }
    if (total > 0) process.exitCode = 1
  }
}
