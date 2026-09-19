import MarkdownIt from 'markdown-it'

/**
 * 创建 doc 页正文的渲染器。
 *
 * section number 不落盘，在这里按标题层级算出来（## → 1，### → 1.1），
 * 同时写入锚点 `<page-id>-1-2`，供跨页引用。见 docs/adr/0005。
 */
export function createRenderer(pageId) {
  const md = new MarkdownIt({ html: false, linkify: false })

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
