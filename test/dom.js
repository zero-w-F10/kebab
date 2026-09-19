import { JSDOM } from 'jsdom'

/**
 * 给 node 装一个最小可用的浏览器环境，好让 Milkdown 跑起来 —— 只为测试。
 * 正式运行永远在真浏览器里，这里补的都是 jsdom 缺的那几样。
 */
export function installDom() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://127.0.0.1:1/', pretendToBeVisual: true })
  const { window } = dom

  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.Node = window.Node
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement

  // Milkdown 用的是裸的 addEventListener/CustomEvent 这些，把 window 上的补到全局
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue
    try { globalThis[key] = window[key] } catch { /* 有些是 getter，取不到就算了 */ }
  }
  // jsdom 的类必须盖过 node 内置的同名类，否则 dispatchEvent 不认自己派发的事件
  for (const key of [
    'Event', 'CustomEvent', 'MouseEvent', 'MutationObserver', 'EventTarget', 'File', 'FileList',
    'Blob', 'FormData', 'Text', 'DocumentFragment', 'Range', 'Selection', 'XMLSerializer',
    'DOMParser', 'Image', 'SVGElement',
  ]) {
    if (window[key] !== undefined) globalThis[key] = window[key]
  }
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getComputedStyle', 'getSelection']) {
    globalThis[key] = window[key].bind(window)
  }

  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

  const observer = () => class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = observer()
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = observer()
  window.ResizeObserver = globalThis.ResizeObserver
  window.IntersectionObserver = globalThis.IntersectionObserver

  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })
  }
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {}
  if (!window.Range.prototype.getBoundingClientRect) {
    window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
  }

  return window
}

/**
 * 装 DOM、挂一个编辑器，测试结束自动销毁。
 * 顺序有讲究：Milkdown 的模块在 import 的那一刻就会碰 document，
 * 所以必须先把 DOM 装好，再动态 import 它。
 */
export async function mountEditor(t, markdown) {
  installDom()
  const { mountDocEditor } = await import('../src/editor/ui/doc-editor.js')

  const host = document.createElement('div')
  document.body.append(host)

  const handle = await mountDocEditor({
    root: host,
    markdown,
    onUpload: async () => 'assets/uploaded.png',
    onChange: () => {},
  })
  t.after(() => handle.destroy())
  return handle
}
