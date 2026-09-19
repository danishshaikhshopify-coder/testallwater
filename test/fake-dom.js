// Minimal DOM for running the page script in Node. It deliberately THROWS if anything
// tries to inject HTML strings, so tests prove the UI never uses innerHTML & friends.

export class FakeText {
  constructor(text) {
    this.text = String(text);
  }
}

const forbidden = (name) => () => {
  throw new Error(`${name} must never be used (HTML injection risk)`);
};

export class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.classes = new Set();
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.focused = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  focus() {
    this.focused = true;
  }

  querySelectorAll() {
    return [];
  }

  get classList() {
    return {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      contains: (c) => this.classes.has(c),
      toggle: (c, force) => {
        const on = force ?? !this.classes.has(c);
        on ? this.classes.add(c) : this.classes.delete(c);
        return on;
      },
    };
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return textOf(this);
  }

  set textContent(value) {
    this.children = value === "" ? [] : [new FakeText(value)];
  }

  get innerHTML() {
    return forbidden("innerHTML")();
  }

  set innerHTML(_) {
    forbidden("innerHTML")();
  }

  set outerHTML(_) {
    forbidden("outerHTML")();
  }

  insertAdjacentHTML() {
    forbidden("insertAdjacentHTML")();
  }
}

export function createFakeDocument() {
  const byId = new Map();
  return {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeEl(`#${id}`));
      return byId.get(id);
    },
    querySelectorAll: () => [],
  };
}

export function textOf(node) {
  return node instanceof FakeText ? node.text : node.children.map(textOf).join("");
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const VOID = new Set(["br", "hr"]);

// Serialise like a browser would: text and attribute values are escaped.
export function toHtml(node) {
  if (node instanceof FakeText) return escapeHtml(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join("");
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(toHtml).join("")}</${node.tag}>`;
}

export function allElements(node, found = []) {
  if (node instanceof FakeText) return found;
  found.push(node);
  node.children.forEach((child) => allElements(child, found));
  return found;
}
