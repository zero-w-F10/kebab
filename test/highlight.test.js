import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeHtml, highlightHtml, renderCodeBlock } from '../src/highlight.js'

/**
 * 围栏代码的着色。最要紧的一条是「不改样」：着色只许往正文里插 <span>，
 * 把记号标签全摘掉之后必须逐字等于原文 —— 着色器宁可认不出来，也不能动代码。
 */

/** 摘掉记号标签，剩下的应当是转义后的原文。 */
const strip = (html) => html.replace(/<span class="kebab-tok-[a-z]+">/g, '').replaceAll('</span>', '')

test('高亮只加 <span>，代码一个字符都不改', () => {
  const samples = [
    ['json', '{"a": [1, 2.5, true, null], "b": "x\\"y", "c": {}}'],
    ['js', 'const a = `t${1}` // 行注释\n/* 块注释 */ if (a) f("s", \'t\')'],
    ['sql', "SELECT * FROM t WHERE a = 'x' -- 注释\nAND b <> 3"],
    ['yaml', '# 注释\nname: 运调\nok: true\nlist:\n  - 1\n  - x'],
    ['bash', '#!/bin/sh\ngit commit -m "x" # 注释'],
  ]
  for (const [lang, code] of samples) {
    assert.equal(strip(highlightHtml(code, lang)), escapeHtml(code), `${lang} 的着色改动了原文`)
  }
})

test('json：键、字符串、数字、字面量各归各位', () => {
  const html = highlightHtml('{"dfromCode": "500103", "rid": true, "n": 12, "x": null}', 'json')
  assert.match(html, /<span class="kebab-tok-key">&quot;dfromCode&quot;<\/span>/)
  assert.match(html, /<span class="kebab-tok-string">&quot;500103&quot;<\/span>/)
  assert.match(html, /<span class="kebab-tok-number">12<\/span>/)
  assert.match(html, /<span class="kebab-tok-literal">true<\/span>/)
  assert.match(html, /<span class="kebab-tok-literal">null<\/span>/)
})

test('字符串与注释里的关键字不被着色 —— 它们整段一次吞掉', () => {
  const html = highlightHtml('const s = "const if return" // const', 'js')
  assert.equal((html.match(/kebab-tok-keyword/g) ?? []).length, 1, '只有开头那个 const 是关键字')
  assert.match(html, /<span class="kebab-tok-comment">\/\/ const<\/span>/)
})

test('sql 关键字不分大小写，字段名与 yaml 的键按冒号认', () => {
  assert.equal((highlightHtml('select a from t', 'sql').match(/kebab-tok-keyword/g) ?? []).length, 2)
  assert.match(highlightHtml('name: 运调', 'yaml'), /<span class="kebab-tok-key">name<\/span>/)
})

test('没写语言、text 与 mermaid 的围栏各有各的处理', () => {
  for (const info of ['', 'text', 'mermaid', 'whatever']) {
    const block = renderCodeBlock('就是一段正文\n第二行', info)
    assert.ok(!block.includes('kebab-tok-'), `${info} 不该着色`)
  }

  // 不写语言：不挂牌子、保留空白（ASCII 草图靠它）
  const bare = renderCodeBlock('┌──┐\n│  │\n└──┘', '')
  assert.match(bare, /class="kebab-code"/)
  assert.ok(!bare.includes('kebab-code-lang'))
  assert.ok(!bare.includes('data-lang'))

  // text：不挂牌子，但折行 —— 里面是人话，不是要对齐的图
  const text = renderCodeBlock('一长段中文正文', 'text')
  assert.match(text, /class="kebab-code is-text"/)
  assert.ok(!text.includes('kebab-code-lang'), 'text 不挂牌子')

  // mermaid：挂名字（它认得出，只是不出图），正文原样
  const mermaid = renderCodeBlock('graph TD\n  A --> B', 'mermaid')
  assert.match(mermaid, /<span class="kebab-code-lang">mermaid<\/span>/)
  assert.match(mermaid, /graph TD/)

  // 认不出的语言照挂原文牌子，内容仍旧转义后原样输出
  const weird = renderCodeBlock('a < b\nc', 'whatever')
  assert.match(weird, /data-lang="whatever"/)
  assert.match(weird, /<span class="kebab-code-lang">whatever<\/span>/)
  assert.match(weird, /a &lt; b/)
})

test('围栏里的 html 被转义，注入不进产物', () => {
  const block = renderCodeBlock('<script>alert(1)</script>', 'text')
  assert.ok(!block.includes('<script>'), '不能把 <script> 原样放进产物')
  assert.match(block, /&lt;script&gt;/)

  const json = renderCodeBlock('{"k": "</code><img src=x>"}', 'json')
  assert.ok(!json.includes('<img'), '字符串里的标签也要转义')
})

test('别名与大小写都认', () => {
  assert.match(renderCodeBlock('{"a": 1}', 'JSON'), /data-lang="JSON"/, '牌子照抄作者写的原文')
  assert.match(renderCodeBlock('{"a": 1}', 'JSON'), /kebab-tok-key/, '大小写不碍着色')
  assert.match(renderCodeBlock('const a = 1', 'typescript'), /kebab-tok-keyword/)
  assert.match(renderCodeBlock('a: 1', 'yml'), /kebab-tok-key/)
})
