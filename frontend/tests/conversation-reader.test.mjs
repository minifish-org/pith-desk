import test from 'node:test';
import assert from 'node:assert/strict';
import { findRanges, installConversationReader } from '../src/conversation-reader.ts';

test('find treats regular-expression characters as literal user text', () => {
  assert.deepEqual(findRanges('a+b [x] a+b', 'a+b'), [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
  assert.deepEqual(findRanges('look for [x] or .*', '[x]'), [{ start: 9, end: 12 }]);
  assert.deepEqual(findRanges('look for [x] or .*', '.*'), [{ start: 16, end: 18 }]);
  assert.deepEqual(findRanges('anything', ''), []);
});

test('find preserves offsets for Chinese, emoji, mixed-case text and newlines', () => {
  const text = '截图😀\nCODE code 截图';
  assert.deepEqual(findRanges(text, '截图'), [{ start: 0, end: 2 }, { start: 15, end: 17 }]);
  assert.deepEqual(findRanges(text, 'code'), [{ start: 5, end: 9 }, { start: 10, end: 14 }]);
  assert.deepEqual(findRanges(text, '😀'), [{ start: 2, end: 4 }]);
  assert.deepEqual(findRanges(text, 'missing'), []);
});

// Control browser event ordering: image layout, scroll, animation frame, and
// ResizeObserver can arrive in different orders during a stream update.
function readerFixture(t) {
  function element() {
    const listeners = new Map();
    return { hidden: true, addEventListener: (type, fn) => listeners.set(type, fn), emit: type => listeners.get(type)?.() };
  }
  const field = element(), count = element(), previous = element(), next = element(), close = element();
  const bar = { ...element(), querySelector: selector => ({ input: field, '[data-find-count]': count, '[data-find-previous]': previous, '[data-find-next]': next, '[data-find-close]': close })[selector] };
  let height = 1200, top = 0, resized;
  const scroll = { ...element(), clientHeight: 400, clientWidth: 600, get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(value) { top = Math.max(0, Math.min(value, height - this.clientHeight)); }, getBoundingClientRect: () => ({ top: 0 }) };
  let anchorTop = 500;
  const anchor = { dataset: { readingId: 'message' }, getBoundingClientRect: () => ({ top: anchorTop - top, bottom: anchorTop + 1000 - top }) };
  const messages = { innerHTML: '', childElementCount: 1, querySelectorAll: () => [anchor] };
  const latest = element();
  const frames = new Map();
  let sequence = 0;
  const globals = {
    document: { addEventListener() {} },
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(fn) { resized = fn; } observe() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
  }
  const reader = installConversationReader(scroll, messages, bar, latest);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const render = (id = 'a') => { reader.beforeRender(id); reader.afterRender(); flush(); };
  render();
  return { reader, scroll, latest, flush, render, resize: () => resized(), grow: amount => { height += amount; }, moveAnchor: amount => { anchorTop += amount; }, gap: () => height - scroll.clientHeight - top };
}

test('image decoding immediately before a render preserves automatic following', t => {
  const view = readerFixture(t);
  view.grow(250);
  // No resize notification has run yet when the next stream snapshot arrives.
  view.render();
  assert.equal(view.gap(), 0);
  assert.equal(view.latest.hidden, true);
});

test('layout-induced scroll events cannot disable following before the resize notification', t => {
  const view = readerFixture(t);
  view.grow(250);
  view.scroll.emit('scroll');
  view.resize();
  assert.equal(view.gap(), 0);
});

test('scroll events during a pending render cannot overwrite the saved following preference', t => {
  const view = readerFixture(t);
  view.reader.beforeRender('a');
  view.grow(250);
  view.scroll.emit('scroll');
  view.reader.afterRender();
  view.flush();
  view.grow(150);
  view.render();
  assert.equal(view.gap(), 0);
});

test('manual history reading keeps its anchor through image growth and streaming', t => {
  const view = readerFixture(t);
  view.scroll.scrollTop = 450;
  view.scroll.emit('scroll');
  const offset = 500 - view.scroll.scrollTop;
  view.grow(250);
  view.moveAnchor(250);
  view.render();
  assert.equal(750 - view.scroll.scrollTop, offset);
  assert.equal(view.latest.hidden, false);
  view.grow(100);
  view.render();
  assert.equal(view.scroll.scrollTop, 700);
});

test('temporary content shrinkage does not turn a history reader into a follower', t => {
  const view = readerFixture(t);
  view.scroll.scrollTop = 450;
  view.scroll.emit('scroll');
  view.grow(-300);
  view.resize();
  view.grow(300);
  view.render();
  assert.equal(view.scroll.scrollTop, 450);
  assert.equal(view.latest.hidden, false);
});

test('sending or returning to latest overrides a pending reading-position restore', t => {
  const view = readerFixture(t);
  view.scroll.scrollTop = 450;
  view.scroll.emit('scroll');
  view.reader.beforeRender('a');
  view.grow(250);
  view.reader.afterRender();
  view.reader.followLatest();
  view.flush();
  view.grow(100);
  view.render();
  assert.equal(view.gap(), 0);
});

test('conversation switching restores history position and following independently', t => {
  const view = readerFixture(t);
  view.scroll.scrollTop = 450;
  view.scroll.emit('scroll');
  view.render('b');
  assert.equal(view.gap(), 0);
  view.render('a');
  assert.equal(view.scroll.scrollTop, 450);
  view.grow(250);
  view.render('b');
  assert.equal(view.gap(), 0);
});
