'use strict'
// jsdom gaps that S2's TableView needs (its virtualizer and sticky header): observers and a layout size.
// With 0 x 0 elements (jsdom has no layout) the virtualizer renders no rows; React Spectrum's own test
// docs mock clientWidth/clientHeight the same way.
class NoopObserver {
  observe () {}
  unobserve () {}
  disconnect () {}
  takeRecords () { return [] }
}
global.IntersectionObserver = global.IntersectionObserver || NoopObserver
global.ResizeObserver = global.ResizeObserver || NoopObserver
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 1000 })
// S2 Tabs waits for the selection indicator's animations; jsdom has no Web Animations API.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
