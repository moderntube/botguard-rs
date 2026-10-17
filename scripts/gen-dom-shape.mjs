// Dumps jsdom's DOM surface (interfaces, members, value types) to src/dom-shape.json.
// usage: node scripts/gen-dom-shape.mjs <bgutil-server-dir> > src/dom-shape.json
import { createRequire } from "node:module";
import vm from "node:vm";

const nodeGlobal = Object.getOwnPropertyNames(globalThis).map((k) => {
  const d = Object.getOwnPropertyDescriptor(globalThis, k);
  const v = d.get ? globalThis[k] : d.value;
  return { k, t: typeof v, e: d.enumerable, get: !!d.get, len: typeof v === "function" ? v.length : 0 };
});

const require = createRequire(process.argv[2] + "/package.json");
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
  url: "https://www.youtube.com/",
  referrer: "https://www.youtube.com/",
});
const w = dom.window;

const TAGS = [
  "a", "div", "span", "img", "iframe", "canvas", "video", "audio", "input", "script", "style", "link",
  "p", "button", "form", "select", "option", "textarea", "table", "ul", "li", "body", "head", "html", "meta",
];
const samples = new Map();
for (const t of TAGS) {
  const el = w.document.createElement(t);
  samples.set(el.constructor.name, el);
}
samples.set("HTMLDocument", w.document);
samples.set("Document", w.document);
samples.set("Location", w.location);
samples.set("Screen", w.screen);
samples.set("History", w.history);
samples.set("MouseEvent", w.document.createEvent("MouseEvents"));
samples.set("Text", w.document.createTextNode(""));
samples.set("CSSStyleDeclaration", w.document.createElement("div").style);

const describe = (v) => {
  if (v === null) return { t: "null" };
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return { t, v };
  if (t === "function") return { t };
  if (t === "object") return { t, c: v.constructor && v.constructor.name };
  return { t };
};

const ECMASCRIPT = new Set(vm.runInNewContext("Object.getOwnPropertyNames(globalThis)"));
const isIface = (k) => {
  const v = w[k];
  return !ECMASCRIPT.has(k) && typeof v === "function" && /^[A-Z]/.test(k) && v.prototype && Object.getPrototypeOf(v.prototype);
};
const interfaces = {};
for (const name of Object.getOwnPropertyNames(w).filter(isIface)) {
  const C = w[name];
  const parent = Object.getPrototypeOf(C).name || null;
  const sample = samples.get(name) || [...samples.values()].find((s) => C.prototype.isPrototypeOf(s));
  const proto = {};
  for (const k of Object.getOwnPropertyNames(C.prototype)) {
    if (k === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(C.prototype, k);
    if (d.get) {
      let val = { t: "undefined" };
      if (sample) {
        try {
          val = describe(sample[k]);
        } catch {
          val = { t: "throws" };
        }
      }
      proto[k] = { kind: "get", set: !!d.set, ...val };
    } else if (typeof d.value === "function") {
      proto[k] = { kind: "method", len: d.value.length };
    } else {
      proto[k] = { kind: "value", ...describe(d.value) };
    }
  }
  const statics = {};
  for (const k of Object.getOwnPropertyNames(C)) {
    if (["length", "name", "prototype"].includes(k)) continue;
    const d = Object.getOwnPropertyDescriptor(C, k);
    if ("value" in d && typeof d.value !== "function") statics[k] = describe(d.value);
  }
  const tag = Object.prototype.toString.call(C.prototype).slice(8, -1);
  interfaces[name] = { parent, len: C.length, tag, proto, statics };
}

const window = {};
for (const k of Object.getOwnPropertyNames(w)) {
  if (isIface(k) || k.startsWith("_")) continue;
  let v;
  try {
    v = w[k];
  } catch {
    continue;
  }
  window[k] = describe(v);
}
const tags = {};
for (const t of TAGS) tags[t] = w.document.createElement(t).constructor.name;

const styleProps = new Set();
for (let o = w.document.createElement("div").style; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of Object.getOwnPropertyNames(o)) {
    if (!/^\d+$/.test(k) && typeof w.document.createElement("div").style[k] === "string") styleProps.add(k);
  }
}

process.stdout.write(JSON.stringify({ interfaces, window, tags, styleProps: [...styleProps], nodeGlobal }));
