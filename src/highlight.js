/**
 * 围栏代码的着色。构建期就把颜色织进 HTML，产物里没有一行运行时脚本 —— 见 docs/adr/0001。
 *
 * 刻意不引第三方高亮库：正文里出现的语言就这几种（json、js/ts、sql、yaml、shell），
 * 而依赖面每多一个，离线环境与重装就多一处会断的地方。着色器只做两件事：先切注释与字符串，
 * 再认关键字、字面量与数字；认不出来原样吐出 —— 顶多颜色少一点，绝不改代码一个字符。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** 高亮只往正文里插 <span>，代码本身先转义 —— 测试里有一条「不改样」的不变式守着它。 */
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char])

const wrap = (cls, text) => `<span class="kebab-tok-${cls}">${escapeHtml(text)}</span>`

const JS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from',
  'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let',
  'namespace', 'new', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies',
  'static', 'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while',
  'yield',
]

const SQL_KEYWORDS = [
  'add', 'all', 'alter', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'column', 'create',
  'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'from', 'full', 'group', 'having',
  'in', 'index', 'inner', 'insert', 'into', 'is', 'join', 'key', 'left', 'like', 'limit', 'not',
  'null', 'offset', 'on', 'or', 'order', 'outer', 'primary', 'references', 'right', 'select',
  'set', 'table', 'then', 'union', 'unique', 'update', 'values', 'when', 'where',
]

const SHELL_KEYWORDS = [
  'alias', 'awk', 'cat', 'cd', 'chmod', 'cp', 'curl', 'docker', 'echo', 'elif', 'else', 'esac',
  'exit', 'export', 'fi', 'for', 'function', 'git', 'grep', 'if', 'kubectl', 'local', 'ls',
  'mkdir', 'mv', 'node', 'npm', 'pnpm', 'read', 'return', 'rm', 'sed', 'set', 'source', 'sudo',
  'then', 'touch', 'while', 'zsh',
]

const lower = (list) => new Set(list)

/**
 * 一种语言的着色规则。认不出的语言不在这儿，走纯文本那条路。
 * - `strings`：引号种类；`line` / `block` / `hash`：三种注释写法
 * - `keyOnColon`：后面紧跟 `:` 的当键名（JSON 的键、YAML 的字段、TS 的字段名）
 */
const RULES = {
  json: {
    strings: ['"'], line: null, block: null, hash: false,
    keywords: new Set(), literals: lower(['true', 'false', 'null']),
    keyOnColon: true, fnOnParen: false,
  },
  js: {
    strings: ['"', "'", '`'], line: '//', block: ['/*', '*/'], hash: false,
    keywords: lower(JS_KEYWORDS), literals: lower(['true', 'false', 'null', 'undefined', 'NaN']),
    keyOnColon: true, fnOnParen: true,
  },
  sql: {
    strings: ["'", '"'], line: '--', block: ['/*', '*/'], hash: false,
    keywords: lower(SQL_KEYWORDS), literals: lower(['true', 'false', 'null']),
    keyOnColon: false, fnOnParen: true, caseInsensitive: true,
  },
  yaml: {
    strings: ['"', "'"], line: null, block: null, hash: true,
    keywords: new Set(), literals: lower(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']),
    keyOnColon: true, fnOnParen: false,
  },
  bash: {
    strings: ['"', "'"], line: null, block: null, hash: true,
    keywords: lower(SHELL_KEYWORDS), literals: new Set(),
    keyOnColon: false, fnOnParen: false,
  },
}

/** 围栏上写的语言 → 用哪套规则。别名很多，认不出就返回 null（纯文本渲染）。 */
const ALIASES = {
  json: 'json', jsonc: 'json', json5: 'json',
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  yaml: 'yaml', yml: 'yaml',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
}

/** 不带语言标记的围栏：压根不挂牌子，免得把大段正文挂成代码。 */
const PLAIN = new Set([''])

/** `text` 这类围栏里通常是人话（提示词、字段说明），不是要对齐的图 —— 它们折行，其余保留空白。 */
const TEXTY = new Set(['text', 'txt', 'plain', 'plaintext', 'none'])

const NUMBER = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/
const IDENT_CHAR = /[A-Za-z0-9_$]/

/**
 * 逐段扫描。每一轮只往前推一个记号，认不出的字符按原文转义后吐出。
 * 字符串与注释都是一次吞掉整段 —— 里面的关键字、`#`、引号因此不会被误判。
 */
function tokenize(code, rules) {
  let out = ''
  let i = 0

  while (i < code.length) {
    const ch = code[i]
    const rest = code.slice(i)

    const lineMark = rules.hash && ch === '#' ? '#' : rules.line && rest.startsWith(rules.line) ? rules.line : null
    if (lineMark) {
      const stop = code.indexOf('\n', i)
      const end = stop === -1 ? code.length : stop
      out += wrap('comment', code.slice(i, end))
      i = end
      continue
    }

    if (rules.block && rest.startsWith(rules.block[0])) {
      const found = code.indexOf(rules.block[1], i + rules.block[0].length)
      const end = found === -1 ? code.length : found + rules.block[1].length
      out += wrap('comment', code.slice(i, end))
      i = end
      continue
    }

    const quote = rules.strings.find((mark) => ch === mark)
    if (quote) {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === quote) {
          j += 1
          break
        }
        j += 1
      }
      const text = code.slice(i, j)
      const isKey = rules.keyOnColon && /^\s*:/.test(code.slice(j))
      out += wrap(isKey ? 'key' : 'string', text)
      i = j
      continue
    }

    if (!IDENT_CHAR.test(code[i - 1] ?? '')) {
      const number = NUMBER.exec(rest)
      if (number) {
        out += wrap('number', number[0])
        i += number[0].length
        continue
      }
    }

    const ident = IDENT.exec(rest)
    if (ident) {
      const word = ident[0]
      const key = rules.caseInsensitive ? word.toLowerCase() : word
      const after = code.slice(i + word.length)
      if (rules.keywords.has(key)) out += wrap('keyword', word)
      else if (rules.literals.has(key)) out += wrap('literal', word)
      else if (rules.keyOnColon && /^\s*:/.test(after)) out += wrap('key', word)
      else if (rules.fnOnParen && /^\s*\(/.test(after)) out += wrap('fn', word)
      else out += escapeHtml(word)
      i += word.length
      continue
    }

    out += escapeHtml(ch)
    i += 1
  }

  return out
}

/** 代码 → 着色后的 HTML。语言不认得就原样转义输出，一个字符不改。 */
export function highlightHtml(code, language) {
  const rules = RULES[ALIASES[String(language ?? '').toLowerCase()]]
  return rules ? tokenize(code, rules) : escapeHtml(code)
}

/**
 * 一个围栏代码块的完整 HTML：卡片 + 右上角的语言牌子 + 着色后的正文。
 * 产物是纯静态的，样式全在 kebab.css 里（.kebab-code / .kebab-tok-*）。
 *
 * 牌子的取舍：认得出的语言、以及 `mermaid` 这类认得出但不出图的，都挂上名字；
 * `text` 与不写语言的围栏不挂 —— 它们多半是大段正文或 ASCII 草图，挂个牌子反而像报错。
 */
export function renderCodeBlock(code, info) {
  const language = String(info ?? '').trim().split(/\s+/)[0] ?? ''
  const token = language.toLowerCase()
  const body = code.replace(/\n$/, '')
  const texty = TEXTY.has(token)
  const badge = token && !texty && !PLAIN.has(token)
    ? `<span class="kebab-code-lang">${escapeHtml(language)}</span>`
    : ''

  return `<div class="kebab-code${texty ? ' is-text' : ''}"`
    + (token ? ` data-lang="${escapeHtml(language)}"` : '')
    + `>${badge}<pre class="kebab-code-block"><code>${highlightHtml(body, token)}</code></pre>`
    + '</div>'
}
