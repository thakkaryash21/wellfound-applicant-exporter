// A DOM for the panel, not a DOM in general.
//
// panel.js is the extension's wiring: it writes markup into #screen and then
// hangs listeners off what it wrote. Testing that wiring needs a document, and
// the two honest options were jsdom or this. jsdom is a large dependency to
// carry for one file's worth of `getElementById`, `innerHTML` and `click`, so
// this stubs exactly the surface the panel modules actually touch and nothing
// else. If a test here fails in a way a browser would not, the fault is far more
// likely to be in this file than in the panel - so it is kept small enough to
// read in one sitting.
//
// Supported, because the panel uses them: parsing an innerHTML string back into
// elements, serialising them again, getElementById, querySelector(All) with tag
// / .class / #id / [attr="v"] and descendant combinators, textContent, value,
// checked, disabled, open, dataset, classList, addEventListener plus dispatch,
// append, remove, insertAdjacentHTML('afterend'), and no-op animate/focus.
//
// Not supported, because nothing uses it: layout, styles as anything but a bag,
// bubbling, capture, default actions, namespaces, or entity forms beyond the
// five escapeHtml writes.

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'area']);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decode(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match]);
}

function encode(text) {
  return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

class TextNode {
  constructor(text) {
    this.text = text;
    this.parent = null;
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.tag = tag;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.style = {};
    this._value = null;
    this._checked = null;
    const element = this;
    // data-* both ways: the panel reads `dataset.id` off markup it wrote, and
    // library.js writes `dataset.running` as a flag.
    this.dataset = new Proxy(
      {},
      {
        get: (_t, key) => element.getAttribute(`data-${dashed(String(key))}`) ?? undefined,
        set: (_t, key, value) => {
          element.setAttribute(`data-${dashed(String(key))}`, String(value));
          return true;
        },
        has: (_t, key) => element.attrs.has(`data-${dashed(String(key))}`),
      },
    );
    this.classList = {
      add: (...names) => {
        const set = classSet(element);
        for (const name of names) set.add(name);
        element.setAttribute('class', [...set].join(' '));
      },
      remove: (...names) => {
        const set = classSet(element);
        for (const name of names) set.delete(name);
        element.setAttribute('class', [...set].join(' '));
      },
      contains: (name) => classSet(element).has(name),
    };
  }

  // --- attributes -----------------------------------------------------------

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(next) {
    this.setAttribute('class', String(next));
  }

  get type() {
    return this.getAttribute('type');
  }

  // Settable, like className: the Library builds its file input in script
  // rather than in markup, so `input.type = 'file'` is a real thing the panel
  // does to an element it made.
  set type(next) {
    this.setAttribute('type', String(next));
  }

  // A form control's value is a property that starts life at the attribute, so
  // markup rendered with value="25" reads back 25 until the user types.
  //
  // A textarea is the exception, and it matters: it has no value attribute at
  // all, its value starts as the text between its tags. Without this, a panel
  // that renders a message into a textarea and reads it back out would read an
  // empty string here and the operator's wording in a browser - the fake
  // agreeing with the code rather than with the platform.
  get value() {
    if (this._value !== null) return this._value;
    const attr = this.getAttribute('value');
    if (attr !== null) return attr;
    return this.tag === 'textarea' ? this.textContent : '';
  }

  set value(next) {
    this._value = String(next);
  }

  get checked() {
    return this._checked ?? this.hasAttribute('checked');
  }

  set checked(next) {
    this._checked = Boolean(next);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(next) {
    if (next) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(next) {
    if (next) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get open() {
    return this.hasAttribute('open');
  }

  set open(next) {
    if (next) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  // --- tree -----------------------------------------------------------------

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === 'string' ? new TextNode(node) : node);
    }
  }

  remove() {
    const siblings = this.parent?.children;
    if (!siblings) return;
    const at = siblings.indexOf(this);
    if (at >= 0) siblings.splice(at, 1);
    this.parent = null;
  }

  get childElementCount() {
    return this.children.filter((c) => c instanceof FakeElement).length;
  }

  get firstElementChild() {
    return this.children.find((c) => c instanceof FakeElement) ?? null;
  }

  // Only 'afterend', which is the one position library.js uses.
  insertAdjacentHTML(position, html) {
    if (position !== 'afterend') throw new Error(`fake-dom: unsupported position ${position}`);
    const siblings = this.parent?.children;
    if (!siblings) return;
    const at = siblings.indexOf(this);
    const added = parseHtml(html);
    for (const node of added) node.parent = this.parent;
    siblings.splice(at + 1, 0, ...added);
  }

  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child instanceof FakeElement) {
          out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => matchesSelector(el, selector, this));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // --- content --------------------------------------------------------------

  set innerHTML(html) {
    this.children = [];
    for (const node of parseHtml(String(html))) this.appendChild(node);
  }

  get innerHTML() {
    return this.children.map(serialize).join('');
  }

  get textContent() {
    return this.children
      .map((c) => (c instanceof TextNode ? c.text : c.textContent))
      .join('');
  }

  set textContent(text) {
    this.children = [];
    this.appendChild(new TextNode(String(text)));
  }

  // --- events ---------------------------------------------------------------

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  // No bubbling: every listener the panel registers sits on the element it is
  // about, so a handler that never fires here would never fire in a browser for
  // the same reason.
  dispatch(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, ...extra };
    const handlers = [...(this.listeners.get(type) ?? [])];
    return Promise.all(handlers.map((handler) => handler(event)));
  }

  // An event object, as a caller in a page would build one. Only the type is
  // consulted here; there is no bubbling, so a listener sits on the element the
  // event is dispatched to.
  dispatchEvent(event) {
    this.dispatch(event?.type, event);
    return true;
  }

  click() {
    return this.dispatch('click');
  }

  // The reviewer decides whether a control is visible before it clicks it. A
  // browser answers that with layout; here a test says so directly, by setting
  // `rect` to a zero-sized box for something the page is not showing.
  getBoundingClientRect() {
    return this.rect ?? { width: 120, height: 32, top: 0, left: 0, bottom: 32, right: 120 };
  }

  // --- stubs the panel calls but never observes -----------------------------

  animate() {
    return { cancel() {} };
  }

  // Recorded rather than ignored. Which control a screen puts the focus on is a
  // real decision on the confirm screen: the button that sends a few hundred
  // messages must not be the one a stray Enter lands on.
  focus() {
    if (globalThis.document instanceof FakeDocument) globalThis.document.activeElement = this;
  }
}

function dashed(key) {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

function classSet(element) {
  return new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
}

function serialize(node) {
  if (node instanceof TextNode) return encode(node.text);
  const attrs = [...node.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`)).join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs} />`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}

// --- parsing ----------------------------------------------------------------

// The end of a tag, skipping any '>' that sits inside a quoted attribute value.
function tagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return html.length;
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(source, element) {
  ATTR.lastIndex = 0;
  let match = ATTR.exec(source);
  while (match) {
    element.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
    match = ATTR.exec(source);
  }
}

export function parseHtml(html) {
  const root = new FakeElement('fragment');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (text) => {
    if (text) top().appendChild(new TextNode(decode(text)));
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    addText(html.slice(i, lt));
    const gt = tagEnd(html, lt + 1);
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('!')) continue;
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const name = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
    if (!name) continue;
    const element = new FakeElement(name[1].toLowerCase());
    parseAttrs(body.slice(name[1].length), element);
    top().appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(element.tag)) stack.push(element);
  }

  const nodes = root.children;
  for (const node of nodes) node.parent = null;
  return nodes;
}

// --- selectors --------------------------------------------------------------

// One compound selector: a tag and any number of #id, .class and [attr="v"].
function matchesSimple(element, part) {
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(part);
  if (tag && element.tag !== tag[0]) return false;
  const tokens = part.slice(tag ? tag[0].length : 0);
  const pattern = /#([-\w]+)|\.([-\w]+)|\[([-\w]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let match = pattern.exec(tokens);
  while (match) {
    const [, id, cls, attr, value] = match;
    if (id && element.id !== id) return false;
    if (cls && !element.classList.contains(cls)) return false;
    if (attr) {
      if (!element.hasAttribute(attr)) return false;
      if (value !== undefined && element.getAttribute(attr) !== value) return false;
    }
    match = pattern.exec(tokens);
  }
  return true;
}

function matchesSelector(element, selector, root) {
  return selector.split(',').some((one) => {
    const parts = one.trim().split(/\s+/);
    if (!matchesSimple(element, parts[parts.length - 1])) return false;
    let ancestor = element.parent;
    for (let p = parts.length - 2; p >= 0; p -= 1) {
      while (ancestor && ancestor !== root && !matchesSimple(ancestor, parts[p])) {
        ancestor = ancestor.parent;
      }
      if (!ancestor || ancestor === root) return false;
      ancestor = ancestor.parent;
    }
    return true;
  });
}

// --- document ---------------------------------------------------------------

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.body = this.documentElement.appendChild(new FakeElement('body'));
    // Keyboard traffic in a page goes to the document, so the document listens
    // and dispatches like an element does.
    this.events = new FakeElement('document');
    this.activeElement = null;
  }

  addEventListener(type, handler) {
    this.events.addEventListener(type, handler);
  }

  removeEventListener(type, handler) {
    this.events.removeEventListener(type, handler);
  }

  dispatchEvent(event) {
    return this.events.dispatchEvent(event);
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  getElementById(id) {
    return this.documentElement.descendants().find((el) => el.id === id) ?? null;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

// breath-lane.js asks for the reduced-motion preference at import time, so a
// window has to exist before panel.js is imported at all.
export function installFakeDom({ reducedMotion = false } = {}) {
  const document = new FakeDocument();
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = document;
  globalThis.window = {
    document,
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
  };
  return {
    document,
    // The panel's own markup, as panel.html has it. Called by a test once it is
    // ready for the bootstrap to find its mount point.
    mountPanel() {
      document.body.innerHTML =
        '<header class="topbar"><button id="nav-library" type="button"></button></header>' +
        '<main id="screen"></main>';
      return document.getElementById('screen');
    },
    restore() {
      globalThis.document = previous.document;
      globalThis.window = previous.window;
    },
  };
}
