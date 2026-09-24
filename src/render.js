import MarkdownIt from 'markdown-it'

import { renderCodeBlock } from './highlight.js'
import { esc } from './layout.js'

/** 这张图是不是已经在链接里（`[![说明](图)](地址)`）—— 往回数，看有没有没闭合的 link_open。 */
function insideLink(tokens, index) {
  let depth = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (tokens[i].type === 'link_close') depth += 1
    else if (tokens[i].type === 'link_open') {
      if (depth === 0) return true
      depth -= 1
    }
  }
  return false
}

/**
 * 创建 doc 页正文的渲染器。
 *
 * section number 不落盘，在这里按标题层级算出来（## → 1，### → 1.1），
 * 同时写入锚点 `<page-id>-1-2`，供跨页引用。见 docs/adr/0005。
 */
export function createRenderer(pageId) {
  const md = new MarkdownIt({ html: false, linkify: false })

  // 围栏代码渲染成卡片，语言认得出来的在这里就着好色（构建期，产物里没有运行时脚本）
  md.renderer.rules.fence = (tokens, index) => renderCodeBlock(
    tokens[index].content,
    tokens[index].info,
  )

  // 图片点开放大。产物里不许有运行时脚本（见 docs/adr/0001），所以放大交给 HTML 的
  // popover：正文里那颗图包一层带 `popovertarget` 的按钮，旁边放一份铺满视口的放大层。
  // 打开、按 Esc 退出、点空白处退出全是浏览器原生行为 —— popover=auto 本来就响应
  // Esc 与层外点击，放大层里再压一颗占满视口的透明按钮，把「图周围的空白」也接住。
  // 见 docs/adr/0012
  const renderImage = md.renderer.rules.image
  let zooms = 0

  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const img = renderImage(tokens, index, options, env, self)
    const src = tokens[index].attrGet('src')
    // 已经在链接里的图原样留着：按钮套进 a 里，一次点击会同时触发放大和跳转
    if (!src || insideLink(tokens, index)) return img

    zooms += 1
    const id = esc(`${pageId}-zoom-${zooms}`)
    return `<button type="button" class="kebab-zoom" popovertarget="${id}" title="点击放大查看">${img}</button>`
      + `<span class="kebab-zoom-view" id="${id}" popover role="dialog" aria-label="放大查看图片">`
      + `<button type="button" class="kebab-zoom-out" popovertarget="${id}" title="点击空白处或按 Esc 退出" aria-label="退出放大查看"></button>`
      + img
      + '</span>'
  }

  md.core.ruler.push('kebab_section_number', (state) => {
    const counters = [0, 0, 0, 0, 0, 0, 0] // 下标即标题层级，h2 起算

    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return
      const level = Number(token.tag.slice(1))
      if (level < 2) return // h1 留给页面标题，不参与编号

      counters[level] += 1
      for (let deeper = level + 1; deeper <= 6; deeper += 1) counters[deeper] = 0

      const number = counters.slice(2, level + 1).join('.')
      token.attrSet('id', `${pageId}-${number.replaceAll('.', '-')}`)

      const label = new state.Token('html_inline', '', 0)
      label.content = `<span class="kebab-section-number">${number}</span> `
      state.tokens[i + 1].children.unshift(label)
    })
  })

  return md
}
