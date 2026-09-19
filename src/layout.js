import { entryOf } from './doctor.js'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char])

export const hrefOf = (page) => `${page.id}.html`

/**
 * 导航树。构建时烘焙进每个 HTML —— 产物不带任何运行时 JS，见 docs/adr/0001。
 */
export function renderNav(site, currentId) {
  const modules = (site.modules ?? [])
    .map((mod) => {
      const links = (mod.pages ?? [])
        .map((page) => {
          const current = page.id === currentId
          const marker = current ? ' class="is-current" aria-current="page"' : ''
          return `<li><a href="${hrefOf(page)}"${marker}>`
            + `<span class="kebab-code">${esc(page.code)}</span>`
            + `<span class="kebab-title">${esc(page.title)}</span></a></li>`
        })
        .join('\n        ')
      return `<li class="kebab-module">
      <div class="kebab-module-title">${esc(mod.title)}</div>
      <ul>
        ${links}
      </ul>
    </li>`
    })
    .join('\n    ')

  const title = site.site?.title ?? '未命名站点'
  const subtitle = site.site?.subtitle

  return `<nav class="kebab-nav">
  <a class="kebab-brand" href="index.html">
    <span class="kebab-brand-title">${esc(title)}</span>
    ${subtitle ? `<span class="kebab-brand-sub">${esc(subtitle)}</span>` : ''}
  </a>
  <ul class="kebab-tree">
    ${modules}
  </ul>
</nav>`
}

export function renderShell(site, page, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} — ${esc(site.site?.title ?? '')}</title>
<link rel="stylesheet" href="kebab.css">
</head>
<body>
<div class="kebab-shell">
${renderNav(site, page.id)}
<main class="kebab-main">
${body}
</main>
</div>
</body>
</html>
`
}

export function renderDocBody(page, html) {
  return `<article class="kebab-doc">
  <header class="kebab-page-head">
    <span class="kebab-code">${esc(page.code)}</span>
    <h1>${esc(page.title)}</h1>
  </header>
  <div class="kebab-prose">
${html}
  </div>
</article>`
}

export function renderProtoBody(page) {
  const src = `prototypes/${page.id}/${entryOf(page)}`
  return `<div class="kebab-proto">
  <div class="kebab-proto-bar">
    <span class="kebab-code">${esc(page.code)}</span>
    <span class="kebab-proto-title">${esc(page.title)}</span>
    <a class="kebab-proto-full" href="${esc(src)}" target="_blank" rel="noopener">全屏打开</a>
  </div>
  <iframe class="kebab-proto-frame" src="${esc(src)}" title="${esc(page.title)}"></iframe>
</div>`
}

/** 单个产品原型的概览页：站点标题加模块列表。 */
export function renderOverview(site) {
  const modules = (site.modules ?? [])
    .map((mod) => `<section class="kebab-overview-module">
    <h2>${esc(mod.title)}</h2>
    <ul>
      ${(mod.pages ?? [])
        .map((page) => `<li><a href="${hrefOf(page)}">`
          + `<span class="kebab-code">${esc(page.code)}</span> ${esc(page.title)}`
          + `</a></li>`)
        .join('\n      ')}
    </ul>
  </section>`)
    .join('\n  ')

  const total = (site.modules ?? []).reduce((sum, mod) => sum + (mod.pages ?? []).length, 0)

  return `<article class="kebab-doc kebab-overview">
  <header class="kebab-page-head">
    <h1>${esc(site.site?.title ?? '未命名站点')}</h1>
    <p class="kebab-overview-meta">${total} 个页面 · ${(site.modules ?? []).length} 个模块</p>
  </header>
  ${modules}
</article>`
}

/** 根门户页：列出全部产品原型。 */
export function renderPortalPage(entries) {
  const items = entries
    .map(({ id, site, built }) => {
      const modules = site.modules ?? []
      const pages = modules.reduce((sum, mod) => sum + (mod.pages ?? []).length, 0)
      const title = site.site?.title ?? id
      const href = `../sites/${id}/dist/index.html`
      const meta = [
        id,
        `${pages} 个页面`,
        `${modules.length} 个模块`,
        site.site?.subtitle,
      ].filter(Boolean).map(esc).join(' · ')

      const right = built
        ? `<a class="kebab-portal-open" href="${href}">打开</a>`
        : '<span class="kebab-portal-open is-missing">尚未构建</span>'

      return `<li class="kebab-portal-item">
    <div>
      ${built ? `<a class="kebab-portal-title" href="${href}">${esc(title)}</a>`
        : `<span class="kebab-portal-title">${esc(title)}</span>`}
      <p class="kebab-portal-meta">${meta}</p>
    </div>
    ${right}
  </li>`
    })
    .join('\n  ')

  const ready = entries.filter((entry) => entry.built).length

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>产品原型</title>
<link rel="stylesheet" href="kebab.css">
</head>
<body>
<main class="kebab-portal">
  <header class="kebab-page-head">
    <h1>产品原型</h1>
    <p class="kebab-overview-meta">${entries.length} 个产品原型，${ready} 个可以打开</p>
  </header>
  <ul class="kebab-portal-list">
  ${items}
  </ul>
</main>
</body>
</html>
`
}
