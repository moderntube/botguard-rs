// Recording browser environment for the BotGuard probe.
// Every host object is a Proxy that logs each property BotGuard reads, tests or calls.
(function () {
  const REAL = globalThis;
  const CFG = REAL.__BG;
  const O = Object;
  const SYM = Symbol;
  const seen = new Set();
  const log = [];
  const rec = (kind, path, extra) => {
    const key = kind + " " + path;
    if (seen.has(key)) return;
    seen.add(key);
    log.push(extra === undefined ? key : key + " -> " + extra);
  };

  const targets = new WeakMap();
  const unwrap = (v) => (v && targets.has(v) ? targets.get(v) : v);
  const probe = (target, path) => {
    if (!CFG.probe) return target;
    const p = new Proxy(target, {
      get(t, k) {
        const name = String(k);
        const full = path + "." + name;
        const present = k in t;
        const v = Reflect.get(t, k, t);
        rec(present ? "get" : "MISS", full, typeof v);
        if (typeof k === "symbol" || name === "prototype" || name === "constructor") return v;
        if (v && (typeof v === "object" || typeof v === "function") && !targets.has(v) && !isBuiltin(v)) {
          return probe(v, full);
        }
        return v;
      },
      has(t, k) {
        const r = Reflect.has(t, k);
        if (!r && k in REAL) return false;
        rec(r ? "has" : "HAS-MISS", path + "." + String(k));
        return r;
      },
      set(t, k, v) {
        rec("set", path + "." + String(k), typeof v + " " + String(v).slice(0, 200));
        t[k] = v;
        return true;
      },
      apply(t, self, args) {
        rec("call", path + "(" + args.map((a) => typeof a + ":" + String(a).slice(0, 80)).join(", ") + ")");
        return Reflect.apply(t, unwrap(self), args.map(unwrap));
      },
      construct(t, args) {
        rec("new", path);
        return Reflect.construct(t, args.map(unwrap));
      },
      ownKeys(t) {
        rec("keys", path);
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, k) {
        rec("desc", path + "." + String(k));
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    targets.set(p, target);
    return p;
  };

  const BUILTINS = new Set(
    Object.getOwnPropertyNames(REAL)
      .map((n) => REAL[n])
      .filter((v) => v && (typeof v === "object" || typeof v === "function")),
  );
  const isBuiltin = (v) => BUILTINS.has(v) || v === Function.prototype || v === Object.prototype;

  // Timers run from the host loop via the returned tick().
  const timers = new Map();
  let nextId = 1;
  const setTimeout = (fn, ms, ...args) => {
    const id = nextId++;
    timers.set(id, { at: Date.now() + (ms || 0), fn, args, every: 0 });
    return id;
  };
  const setInterval = (fn, ms, ...args) => {
    const id = nextId++;
    timers.set(id, { at: Date.now() + (ms || 0), fn, args, every: Math.max(ms || 0, 1) });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const btoa = (s) => {
    s = String(s);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error("InvalidCharacterError");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < s.length ? B64[n & 63] : "=");
    }
    return out;
  };
  const atob = (s) => {
    s = String(s).replace(/[\s=]/g, "");
    let out = "", buf = 0, bits = 0;
    for (const ch of s) {
      buf = (buf << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 255);
      }
    }
    return out;
  };

  const { I, make, slot } = CFG.buildDom(CFG.shape);
  const SHAPE = CFG.shape;

  const ET = I.EventTarget.prototype;
  const listeners = (o) => (slot(o).__listeners ||= {});
  ET.addEventListener = function addEventListener(type, fn) {
    const l = listeners(this);
    (l[type] ||= []).push(fn);
  };
  ET.removeEventListener = function removeEventListener(type, fn) {
    const l = listeners(this);
    if (l[type]) l[type] = l[type].filter((f) => f !== fn);
  };
  ET.dispatchEvent = function dispatchEvent(ev) {
    for (const f of listeners(this)[ev.type] || []) f.call(this, ev);
    const on = this["on" + ev.type];
    if (typeof on === "function") on.call(this, ev);
    return true;
  };

  const N = I.Node.prototype;
  const kids = (o) => (slot(o).__kids ||= []);
  N.appendChild = function appendChild(n) {
    kids(this).push(n);
    slot(n).parentNode = this;
    return n;
  };
  N.insertBefore = function insertBefore(n, ref) {
    const k = kids(this);
    const i = k.indexOf(ref);
    k.splice(i < 0 ? k.length : i, 0, n);
    slot(n).parentNode = this;
    return n;
  };
  N.removeChild = function removeChild(n) {
    slot(this).__kids = kids(this).filter((c) => c !== n);
    slot(n).parentNode = null;
    return n;
  };
  N.hasChildNodes = function hasChildNodes() {
    return kids(this).length > 0;
  };

  const E = I.Element.prototype;
  const attrs = (o) => (slot(o).__attrs ||= {});
  E.hasAttribute = function hasAttribute(n) {
    return String(n).toLowerCase() in attrs(this);
  };
  E.getAttribute = function getAttribute(n) {
    return attrs(this)[String(n).toLowerCase()] ?? null;
  };
  E.setAttribute = function setAttribute(n, v) {
    attrs(this)[String(n).toLowerCase()] = String(v);
  };
  E.removeAttribute = function removeAttribute(n) {
    delete attrs(this)[String(n).toLowerCase()];
  };
  E.removeAttributeNS = function removeAttributeNS(_ns, n) {
    delete attrs(this)[String(n).toLowerCase()];
  };
  E.hasAttributes = function hasAttributes() {
    return Object.keys(attrs(this)).length > 0;
  };
  I.HTMLElement.prototype.click = function click() {
    this.dispatchEvent(make("MouseEvent", { type: "click" }));
  };
  I.HTMLCanvasElement.prototype.getContext = function getContext() {
    return null;
  };

  const perfStart = Date.now();
  const location = make("Location", {
    href: "https://www.youtube.com/",
    origin: "https://www.youtube.com",
    protocol: "https:",
    host: "www.youtube.com",
    hostname: "www.youtube.com",
    port: "",
    pathname: "/",
    search: "",
    hash: "",
  });
  let doc;
  const makeWindow = (top) => {
    const w = make("Window");
    for (const [k, m] of Object.entries(SHAPE.window)) {
      if (k in REAL && REAL[k] !== undefined && !(k in w)) {
        // jsdom's window is the script's global, so ECMAScript globals are window members.
        O.defineProperty(w, k, { value: REAL[k], writable: true, enumerable: false, configurable: true });
        continue;
      }
      if (m.t === "string" || m.t === "number" || m.t === "boolean") w[k] = m.v;
      else if (m.t === "null") w[k] = null;
    }
    for (const [k, C] of Object.entries(I)) w[k] = C;
    w.Object = Object;
    w.String = String;
    w.window = w.self = w.globalThis = w.frames = w;
    w.top = w.parent = top || w;
    return w;
  };
  const create = (tag) => {
    const t = String(tag).toLowerCase();
    const cls = SHAPE.tags[t] || "HTMLUnknownElement";
    const up = t.toUpperCase();
    const el = make(cls, { tagName: up, nodeName: up, localName: t, ownerDocument: doc, nodeType: 1 });
    if (cls === "HTMLIFrameElement") {
      const cw = makeWindow(env);
      slot(el).contentWindow = probe(cw, "<iframe>.contentWindow");
    }
    return probe(el, "<" + tag + ">");
  };
  doc = make("HTMLDocument", {
    readyState: "complete",
    hidden: false,
    visibilityState: "visible",
    referrer: "https://www.youtube.com/",
    URL: "https://www.youtube.com/",
    documentURI: "https://www.youtube.com/",
    location,
    cookie: "",
    nodeType: 9,
  });
  const html = make("HTMLHtmlElement", { tagName: "HTML", nodeName: "HTML", localName: "html", nodeType: 1 });
  const head = make("HTMLHeadElement", { tagName: "HEAD", nodeName: "HEAD", localName: "head", nodeType: 1 });
  const body = make("HTMLBodyElement", { tagName: "BODY", nodeName: "BODY", localName: "body", nodeType: 1 });
  Object.assign(slot(doc), { documentElement: html, head, body });
  doc.createElement = create;
  doc.createEvent = (kind) => make(/Mouse/.test(kind) ? "MouseEvent" : "Event", { type: "" });
  doc.createTextNode = (t) => make("Text", { data: String(t), nodeType: 3 });
  doc.hasFocus = () => false;
  doc.getElementsByTagName = (t) => (String(t).toLowerCase() === "script" ? [create("script")] : []);

  class Navigator {}
  for (const [k, v] of Object.entries({
    hardwareConcurrency: 16,
    language: "en-US",
    languages: ["en-US"],
    userAgent: "Node.js/24",
    platform: "Linux x86_64",
  })) {
    Object.defineProperty(Navigator.prototype, k, { get: named("get " + k, () => v), enumerable: true, configurable: true });
  }
  const env = makeWindow(null);
  Object.assign(env, {
    navigator: make("Navigator", {}),
    location,
    document: doc,
    screen: make("Screen", {}),
    history: make("History", {}),
    performance: { now: () => Date.now() - perfStart, timeOrigin: perfStart },
    btoa,
    atob,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval: clearTimeout,
  });
  slot(doc).defaultView = env;
  const WIN = probe(env, "window");

  // The global scope mirrors a bgutil process: Node 24's globals in Node's order, then the
  // four names bgutil assigns (window, document, location, origin).
  function named(name, f) {
    return O.defineProperty(f, "name", { value: name });
  }
  const stubClass = (name, len) => {
    const C = { [name]: class {} }[name];
    O.defineProperty(C, "length", { value: len || 0 });
    O.defineProperty(C.prototype, SYM.toStringTag, { value: name, configurable: true });
    return C;
  };
  const stubFn = (name, len) => O.defineProperty(named(name, function () {}), "length", { value: len || 0 });
  const nodePerformance = O.create(stubClass("Performance").prototype);
  O.assign(nodePerformance, {
    now: () => Date.now() - perfStart,
    timeOrigin: perfStart,
    mark: () => {},
    measure: () => {},
    getEntries: () => [],
    getEntriesByName: () => [],
    getEntriesByType: () => [],
    toJSON: () => ({}),
  });
  const process = { env: {}, argv: [], version: "v24.18.1", versions: { node: "24.18.1" }, platform: "linux", arch: "x64", pid: 1 };
  const own = {
    console: REAL.console || {},
    process,
    global: REAL,
    Buffer: stubClass("Buffer", 2),
    setImmediate: (fn, ...a) => setTimeout(fn, 0, ...a),
    clearImmediate: clearTimeout,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval: clearTimeout,
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    atob,
    btoa,
    performance: nodePerformance,
    navigator: make("Navigator", {}),
    fetch: stubFn("fetch", 0),
    crypto: {},
  };
  const kept = {};
  for (const k of O.getOwnPropertyNames(REAL)) kept[k] = O.getOwnPropertyDescriptor(REAL, k);
  for (const k of O.keys(kept)) {
    try {
      delete REAL[k];
    } catch {}
  }
  for (const g of SHAPE.nodeGlobal) {
    if (O.prototype.hasOwnProperty.call(REAL, g.k)) continue;
    let value;
    if (g.k in own) value = own[g.k];
    else if (kept[g.k] && "value" in kept[g.k]) value = kept[g.k].value;
    else if (g.t === "function") value = /^[A-Z]/.test(g.k) ? stubClass(g.k, g.len) : stubFn(g.k, g.len);
    else if (g.t === "object") value = {};
    else continue;
    if (g.get) {
      O.defineProperty(REAL, g.k, { get: named("get", () => value), set: named("set", (v) => (value = v)), enumerable: g.e, configurable: true });
    } else {
      O.defineProperty(REAL, g.k, { value, writable: true, enumerable: g.e, configurable: true });
    }
  }
  REAL.globalThis = REAL;
  Object.assign(REAL, { window: WIN, document: WIN.document, location: WIN.location, origin: "https://www.youtube.com" });
  if (CFG.ytConfig) {
    env.yt = { config_: JSON.parse(CFG.ytConfig) };
    Object.assign(REAL, { yt: env.yt });
  }

  const state = { stage: "init" };

  const b64ToU8 = (s) => {
    const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "="));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const utf8 = (s) => {
    const bytes = [];
    for (const ch of unescape(encodeURIComponent(s))) bytes.push(ch.charCodeAt(0));
    return new Uint8Array(bytes);
  };
  const Fn = Function;

  return {
    state,
    log: () => log.join("\n"),
    tick() {
      const now = Date.now();
      for (const [id, t] of [...timers]) {
        if (t.at > now) continue;
        if (t.every) t.at = now + t.every;
        else timers.delete(id);
        t.fn(...t.args);
      }
      return timers.size;
    },
    load(src) {
      state.stage = "interpreter";
      new Fn(src)();
    },
    start(program, globalName) {
      state.stage = "vm.a";
      const vm = REAL[globalName];
      state.vm = typeof vm;
      if (!vm || !vm.a) throw new Error("VM " + globalName + " not found");
      const ret = vm.a(
        program,
        (asyncSnapshot, shutdown, passEvent, checkCamera) => {
          state.fns = { asyncSnapshot, shutdown, passEvent, checkCamera };
          state.stage = "fns";
        },
        true,
        undefined,
        () => {},
        [[], []],
      );
      state.sync = typeof (ret && ret[0]);
    },
    snapshot() {
      state.stage = "snapshot";
      state.webPo = [];
      state.fns.asyncSnapshot((r) => {
        state.snapshot = r;
        state.stage = "done";
      }, [undefined, undefined, state.webPo, undefined]);
    },
    minter(integrityToken) {
      state.stage = "minter";
      const getMinter = state.webPo[0];
      if (typeof getMinter !== "function") throw new Error("webPoSignalOutput[0] is " + typeof getMinter);
      Promise.resolve(getMinter(b64ToU8(integrityToken))).then(
        (cb) => {
          state.mintCb = cb;
          state.stage = "minter-ready";
        },
        (e) => {
          state.error = String(e);
          state.stage = "minter-ready";
        },
      );
    },
    mint(identifier) {
      state.stage = "mint";
      state.pot = undefined;
      Promise.resolve(state.mintCb(utf8(identifier))).then(
        (u8) => {
          let s = "";
          for (const b of u8) s += String.fromCharCode(b);
          state.pot = btoa(s).replace(/\+/g, "-").replace(/\//g, "_");
          state.stage = "minted";
        },
        (e) => {
          state.error = String(e);
          state.stage = "minted";
        },
      );
    },
  };
})();
