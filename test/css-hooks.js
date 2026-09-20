/**
 * 测试专用的模块钩子：把 CSS 导入当空模块。
 *
 * 编辑器前端的样式靠 esbuild 处理（`npm run editor:build` 打成 ui.css），Node 本身不认 .css。
 * jsdom 下没有排版可言，样式对测试没有意义，这里让那些导入解析成一个空模块。
 * 用法见 test/editor-ui.test.js 里的 register()。
 */

const STUB = 'kebab:css/'

export async function resolve(specifier, context, nextResolve) {
  // 直接拦在解析之前：这些 .css 子路径走的是包的 exports 映射，不必真去解析
  if (specifier.endsWith('.css')) {
    return { url: STUB + encodeURIComponent(specifier), format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(STUB)) {
    return { format: 'module', shortCircuit: true, source: 'export default {}' }
  }
  return nextLoad(url, context)
}
