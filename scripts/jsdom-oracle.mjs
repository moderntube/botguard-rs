// Runs a fixture the bgutil way (jsdom globals): snapshot + whether webPoSignalOutput[0] fills.
// usage: node scripts/jsdom-oracle.mjs <fixtures-dir> <bgutil-server-dir> [probe-log-out]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [dir, server, probeOut] = process.argv.slice(2);
const require = createRequire(server + "/package.json");
const { JSDOM } = require("jsdom");

const seen = new Set();
const log = [];
const rec = (kind, path, extra) => {
  const key = kind + " " + path;
  if (seen.has(key)) return;
  seen.add(key);
  log.push(extra === undefined ? key : key + " -> " + extra);
};
const targets = new WeakMap();
const proxies = new WeakMap();
const unwrap = (v) => (v && targets.has(v) ? targets.get(v) : v);
const str = (a) => {
  try {
    return typeof a + ":" + String(a).slice(0, 80);
  } catch {
    return typeof a;
  }
};
const probe = (target, path) => {
  if (proxies.has(target)) return proxies.get(target);
  const p = new Proxy(target, {
    get(t, k) {
      const name = String(k);
      const present = k in t;
      const v = Reflect.get(t, k, t);
      rec(present ? "get" : "MISS", path + "." + name, typeof v);
      if (typeof k === "symbol" || name === "prototype" || name === "constructor") return v;
      if (v && (typeof v === "object" || typeof v === "function") && !(name in globalThis && globalThis[name] === v)) {
        return probe(v, path + "." + name);
      }
      return v;
    },
    has(t, k) {
      const r = Reflect.has(t, k);
      rec(r ? "has" : "HAS-MISS", path + "." + String(k));
      return r;
    },
    set(t, k, v) {
      rec("set", path + "." + String(k), str(v));
      return Reflect.set(t, k, unwrap(v), t);
    },
    apply(t, self, args) {
      rec("call", path + "(" + args.map(str).join(", ") + ")");
      const r = Reflect.apply(t, unwrap(self), args.map(unwrap));
      return r && typeof r === "object" && !Array.isArray(r) ? probe(r, path + "()") : r;
    },
    construct(t, args) {
      rec("new", path);
      return Reflect.construct(t, args.map(unwrap));
    },
  });
  targets.set(p, target);
  proxies.set(target, p);
  return p;
};

const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
  url: "https://www.youtube.com/",
  referrer: "https://www.youtube.com/",
});
const wrap = (v, name) => (probeOut ? probe(v, name) : v);
Object.assign(globalThis, {
  window: wrap(dom.window, "window"),
  document: wrap(dom.window.document, "window.document"),
  location: dom.window.location,
  origin: dom.window.origin,
});
if (!Reflect.has(globalThis, "navigator")) {
  Object.defineProperty(globalThis, "navigator", { value: wrap(dom.window.navigator, "window.navigator") });
}

await new Promise((r) => setTimeout(r, 200));
const challenge = JSON.parse(readFileSync(dir + "/challenge.json", "utf8"));
if (probeOut) {
  const shape = JSON.parse(readFileSync(new URL("../src/dom-shape.json", import.meta.url), "utf8"));
  const names = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    ...Object.keys(shape.window),
    ...Object.keys(shape.interfaces),
    "screen", "chrome", "opera", "safari", "InstallTrigger", "mozInnerScreenX", "process", "Buffer", "global",
  ]);
  for (const k of names) {
    if (["__GP", "__SRC", "window", "document", "location", "origin", "navigator", "Array", "Math", "eval", "globalThis"].includes(k)) continue;
    const d = Object.getOwnPropertyDescriptor(globalThis, k);
    if (!d || !d.configurable) continue;
    const present = true;
    let value = present ? globalThis[k] : undefined;
    Object.defineProperty(globalThis, k, {
      get() {
        rec(present ? "gget" : "gMISS", k, typeof value);
        return value;
      },
      set(v) {
        value = v;
      },
      configurable: true,
      enumerable: d ? d.enumerable : false,
    });
  }
}
const globalsSeen = new Set();
const GLOBAL = new Proxy(globalThis, {
  get(t, k) {
    const v = Reflect.get(t, k);
    if (typeof k === "string") rec(k in t ? "get" : "MISS", "globalThis." + k, typeof v);
    return v;
  },
  has(t, k) {
    const r = Reflect.has(t, k);
    if (typeof k === "string") rec(r ? "has" : "HAS-MISS", "globalThis." + k);
    return r;
  },
});
globalThis.__GP = new Proxy(
  { globalThis: GLOBAL },
  {
    get(t, k) {
      return t[k];
    },
    has(_t, k) {
      if (k === "globalThis") return true;
      if (typeof k === "string" && !globalsSeen.has(k)) {
        globalsSeen.add(k);
        log.push("global " + k + " -> " + (k in globalThis ? typeof globalThis[k] : "absent"));
      }
      return false;
    },
  },
);
globalThis.__SRC = readFileSync(dir + "/interpreter.js", "utf8");
if (probeOut) new Function("with (globalThis.__GP) { eval(globalThis.__SRC); }").call(GLOBAL);
else new Function(globalThis.__SRC)();
const vm = globalThis[challenge.globalName];

const t0 = Date.now();
const fns = await new Promise((resolve) => {
  vm.a(challenge.program, (asyncSnapshot) => resolve({ asyncSnapshot }), true, undefined, () => {}, [[], []]);
});
const webPo = [];
const snapshot = await new Promise((resolve) => fns.asyncSnapshot(resolve, [undefined, undefined, webPo, undefined]));
console.log(`snapshot ${snapshot.length} chars ${snapshot.slice(0, 40)} elapsed=${Date.now() - t0}ms`);
console.log(`webPoSignalOutput len=${webPo.length} [0]=${typeof webPo[0]}`);
if (probeOut) writeFileSync(probeOut, log.join("\n"));
if (process.env.BG_MINT) {
  const { BG } = await import(server + "/node_modules/bgutils-js/dist/index.js");
  const r = await fetch("https://www.youtube.com/api/jnn/v1/GenerateIT", {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify(["O43z0dpjhgX20SCx4KAo", snapshot]),
  });
  const [integrityToken] = await r.json();
  console.log(`integrityToken ${integrityToken ? "issued" : "REFUSED"}`);
  const minter = await BG.WebPoMinter.create({ integrityToken }, webPo);
  const pot = await minter.mintAsWebsafeString(process.env.BG_MINT);
  console.log(`pot ${pot.length} chars: ${pot}`);
}
process.exit(0);
