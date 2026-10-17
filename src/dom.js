// Builds DOM interfaces from src/dom-shape.json (jsdom's surface): classes, member stubs,
// getters that return jsdom's default values, and Symbol.toStringTag brands.
globalThis.__BG.buildDom = function (shape) {
  const slots = new WeakMap();
  const slot = (o) => {
    let s = slots.get(o);
    if (!s) slots.set(o, (s = {}));
    return s;
  };
  const I = {};
  const named = (name, f) => Object.defineProperty(f, "name", { value: name });

  const dflt = (o, k, m) => {
    switch (m.t) {
      case "string":
      case "number":
      case "boolean":
        return m.v;
      case "null":
        return null;
      case "object": {
        const s = slot(o);
        if (!(k in s)) s[k] = m.c === "CSSStyleDeclaration" ? style() : I[m.c] ? Object.create(I[m.c].prototype) : {};
        return s[k];
      }
      case "function":
        return named(k, function () {});
      default:
        return undefined;
    }
  };

  const build = (name) => {
    if (I[name]) return I[name];
    const spec = shape.interfaces[name];
    const Parent = spec.parent && shape.interfaces[spec.parent] ? build(spec.parent) : null;
    const C = Parent ? { [name]: class extends Parent {} }[name] : { [name]: class {} }[name];
    Object.defineProperty(C, "length", { value: spec.len });
    Object.defineProperty(C.prototype, Symbol.toStringTag, { value: spec.tag, configurable: true });
    for (const [k, m] of Object.entries(spec.proto)) {
      if (m.kind === "method") {
        const f = named(k, function () {});
        Object.defineProperty(f, "length", { value: m.len });
        Object.defineProperty(C.prototype, k, { value: f, writable: true, enumerable: true, configurable: true });
      } else if (m.kind === "get") {
        Object.defineProperty(C.prototype, k, {
          get: named("get " + k, function () {
            const s = slot(this);
            return k in s ? s[k] : dflt(this, k, m);
          }),
          set: m.set
            ? named("set " + k, function (v) {
                slot(this)[k] = v;
              })
            : undefined,
          enumerable: true,
          configurable: true,
        });
      } else {
        Object.defineProperty(C.prototype, k, { value: m.v, enumerable: true, configurable: true });
      }
    }
    for (const [k, m] of Object.entries(spec.statics)) {
      Object.defineProperty(C, k, { value: m.v, enumerable: true });
    }
    return (I[name] = C);
  };
  for (const name of Object.keys(shape.interfaces)) build(name);

  const make = (name, fields) => {
    const o = Object.create((I[name] || Object).prototype);
    const s = slot(o);
    for (const [k, v] of Object.entries(fields || {})) {
      if (hasGetter(o, k)) s[k] = v;
      else Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: false });
    }
    return o;
  };
  const hasGetter = (o, k) => {
    for (let p = Object.getPrototypeOf(o); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d) return !!d.get;
    }
    return false;
  };
  const style = () => {
    const st = Object.create(I.CSSStyleDeclaration.prototype);
    for (const k of shape.styleProps) st[k] = "";
    return st;
  };
  return { I, make, slot, dflt };
};
