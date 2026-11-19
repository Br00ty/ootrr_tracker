// OOTRR logic engine, ported to JavaScript from realazk/ootrr (crates/core/src: rule_ast.rs, rules.rs, world.rs, search.rs).
// Rules are the OoTR Python-subset strings in data/logic, as ootrr-core 0.6.2 assembles them.
const Engine = (() => {
  "use strict";
  const DAY = 1, DAMPE = 2;
  const AGES = ["adult", "child"];

  // ---------- lexer / parser (rule_ast.rs) ----------
  function lex(t) {
    const out = [];
    let i = 0;
    const SYM2 = ["==", "!=", "<=", ">=", "//"];
    while (i < t.length) {
      const c = t[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < t.length && /[A-Za-z0-9_]/.test(t[j])) j++;
        out.push({ k: "n", v: t.slice(i, j) }); i = j; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < t.length && /[0-9.]/.test(t[j])) j++;
        const s = t.slice(i, j);
        out.push(s.includes(".") ? { k: "f", v: parseFloat(s) } : { k: "i", v: parseInt(s, 10) }); i = j; continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1, s = "";
        while (j < t.length && t[j] !== c) { if (t[j] === "\\") { j++; } s += t[j]; j++; }
        if (j >= t.length) throw new Error("unterminated string");
        out.push({ k: "s", v: s }); i = j + 1; continue;
      }
      const two = t.slice(i, i + 2);
      if (SYM2.includes(two)) { out.push({ k: "y", v: two }); i += 2; continue; }
      if ("()[],+-*/%<>".includes(c)) { out.push({ k: "y", v: c }); i++; continue; }
      throw new Error("bad char " + c);
    }
    out.push({ k: "end" });
    return out;
  }

  function parse(text) {
    const t = lex(text); let i = 0;
    const peek = () => t[i];
    const sym = (s) => { if (t[i].k === "y" && t[i].v === s) { i++; return true; } return false; };
    const kw = (s) => { if (t[i].k === "n" && t[i].v === s) { i++; return true; } return false; };
    const need = (s) => { if (!sym(s)) throw new Error("expected " + s); };
    function expr() {
      const a = orE();
      if (kw("if")) { const c = orE(); if (!kw("else")) throw new Error("expected else"); const b = expr(); return { t: "if", c, a, b }; }
      return a;
    }
    function orE() { const v = [andE()]; while (kw("or")) { const x = andE(); if (x.t === "or") v.push(...x.v); else v.push(x); } return v.length === 1 ? v[0] : { t: "or", v }; }
    function andE() { const v = [notE()]; while (kw("and")) { const x = notE(); if (x.t === "and") v.push(...x.v); else v.push(x); } return v.length === 1 ? v[0] : { t: "and", v }; }
    function notE() { if (kw("not")) return { t: "not", x: notE() }; return cmpE(); }
    function cmpOp() {
      const p = peek(), nx = t[i + 1];
      const nextIs = (w) => nx && nx.k === "n" && nx.v === w;
      let o = null, n = 1;
      if (p.k === "y" && ["==", "!=", "<", "<=", ">", ">="].includes(p.v)) o = p.v;
      else if (p.k === "n" && p.v === "in") o = "in";
      else if (p.k === "n" && p.v === "is") { if (nextIs("not")) { o = "!="; n = 2; } else o = "=="; }
      else if (p.k === "n" && p.v === "not" && nextIs("in")) { o = "notin"; n = 2; }
      if (o) i += n;
      return o;
    }
    function cmpE() { const l = arith(); const r = []; let o; while ((o = cmpOp())) r.push([o, arith()]); return r.length ? { t: "cmp", l, r } : l; }
    function arith() { let l = term(); for (;;) { let op = sym("+") ? "+" : sym("-") ? "-" : null; if (!op) return l; l = { t: "bin", op, a: l, b: term() }; } }
    function term() { let l = unary(); for (;;) { let op = sym("*") ? "*" : sym("//") ? "//" : sym("/") ? "/" : sym("%") ? "%" : null; if (!op) return l; l = { t: "bin", op, a: l, b: unary() }; } }
    function unary() { if (sym("-")) return { t: "neg", x: unary() }; return post(); }
    function args() { const v = []; if (sym(")")) return v; for (;;) { v.push(expr()); if (sym(",")) { if (sym(")")) return v; continue; } need(")"); return v; } }
    function post() {
      const a = atom();
      if (a.t === "name") {
        if (sym("(")) return { t: "call", n: a.v, v: args() };
        if (sym("[")) { const x = expr(); need("]"); return { t: "index", n: a.v, x }; }
      }
      return a;
    }
    function atom() {
      const k = t[i++];
      if (k.k === "n") {
        if (k.v === "True") return { t: "bool", v: true };
        if (k.v === "False" || k.v === "None") return { t: "bool", v: false };
        if (["and", "or", "not", "in", "is", "if", "else"].includes(k.v)) throw new Error("unexpected keyword " + k.v);
        return { t: "name", v: k.v };
      }
      if (k.k === "s") return { t: "str", v: k.v };
      if (k.k === "i") return { t: "int", v: k.v };
      if (k.k === "f") return { t: "float", v: k.v };
      if (k.k === "y" && k.v === "(") {
        if (sym(")")) return { t: "tuple", v: [] };
        const first = expr();
        if (sym(",")) { const v = [first]; while (!sym(")")) { v.push(expr()); if (!sym(",")) { need(")"); break; } } return { t: "tuple", v }; }
        need(")"); return first;
      }
      if (k.k === "y" && k.v === "[") { const v = []; while (!sym("]")) { v.push(expr()); if (!sym(",")) { need("]"); break; } } return { t: "list", v }; }
      throw new Error("unexpected token");
    }
    const a = expr();
    if (peek().k !== "end") throw new Error("trailing input");
    return a;
  }

  // ---------- values (logic_val.rs) ----------
  const isNum = (v) => typeof v === "number" || typeof v === "boolean";
  const num = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v);
  function truthy(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).length > 0;
    return false;
  }
  function same(a, b) {
    if (isNum(a) && isNum(b)) return num(a) === num(b);
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, k) => same(x, b[k]));
    return a === b;
  }
  function member(a, b) {
    if (Array.isArray(b)) return b.some((x) => same(a, x));
    if (typeof b === "string") return typeof a === "string" && b.includes(a);
    if (b && typeof b === "object") return typeof a === "string" && a in b;
    return false;
  }
  function compare(op, a, b) {
    switch (op) {
      case "==": return same(a, b);
      case "!=": return !same(a, b);
      case "in": return member(a, b);
      case "notin": return !member(a, b);
    }
    let o;
    if (isNum(a) && isNum(b)) o = num(a) - num(b);
    else if (typeof a === "string" && typeof b === "string") o = a < b ? -1 : a > b ? 1 : 0;
    else return false;
    return op === "<" ? o < 0 : op === "<=" ? o <= 0 : op === ">" ? o > 0 : o >= 0;
  }
  function arith(op, a, b) {
    if (typeof a === "string" && typeof b === "string" && op === "+") return a + b;
    if (!isNum(a) || !isNum(b)) return undefined;
    const x = num(a), y = num(b);
    switch (op) {
      case "+": return x + y;
      case "-": return x - y;
      case "*": return x * y;
      case "/": return y === 0 ? undefined : x / y;
      case "//": return y === 0 ? undefined : Math.floor(x / y);
      case "%": return y === 0 ? undefined : x - y * Math.floor(x / y);
    }
  }

  // ---------- items ----------
  const escape = (n) => n.replace(/ /g, "_").replace(/['()\[\]\-]/g, "");
  class Items {
    constructor() { this.names = []; this.adv = []; this.event = []; this.ix = new Map(); }
    add(name, adv) { const e = escape(name); if (this.ix.has(e)) return this.ix.get(e); const id = this.names.length; this.names.push(name); this.adv.push(adv); this.event.push(false); this.ix.set(e, id); return id; }
    find(name) { return this.ix.get(escape(name)); }
    findEsc(e) { return this.ix.get(e); }
    eventNamed(name) { const f = this.find(name); if (f !== undefined) return f; const id = this.names.length; this.names.push(name); this.adv.push(true); this.event.push(true); this.ix.set(escape(name), id); return id; }
  }

  // ---------- compiler (rules.rs) ----------
  const C = (v) => ({ t: "const", v });
  const eventLike = (n) => /^[A-Z]/.test(n);
  function subst(a, m) {
    switch (a.t) {
      case "name": return m.has(a.v) ? m.get(a.v) : a;
      case "tuple": case "list": case "and": case "or": return { ...a, v: a.v.map((x) => subst(x, m)) };
      case "call": return { ...a, v: a.v.map((x) => subst(x, m)) };
      case "index": return { ...a, x: subst(a.x, m) };
      case "not": case "neg": return { ...a, x: subst(a.x, m) };
      case "cmp": return { t: "cmp", l: subst(a.l, m), r: a.r.map(([o, x]) => [o, subst(x, m)]) };
      case "bin": return { ...a, a: subst(a.a, m), b: subst(a.b, m) };
      case "if": return { t: "if", c: subst(a.c, m), a: subst(a.a, m), b: subst(a.b, m) };
      default: return a;
    }
  }

  class Compiler {
    constructor(items, settings, aliases, groups) {
      this.items = items; this.settings = settings; this.aliases = aliases; this.groups = groups;
      this.subs = []; this.subIx = new Map(); this.subN = new Map(); this.warn = [];
    }
    setting(n) { return Object.prototype.hasOwnProperty.call(this.settings, n) ? this.settings[n] : undefined; }
    rule(text, sp) { return this.ruleAst(typeof text === "string" ? parse(text) : text, sp); }
    ruleAst(a, sp) { const node = this.comp(a, sp, 0); return mkRule(node); }
    comp(a, sp, d) {
      if (d > 64) throw new Error("expansion too deep");
      switch (a.t) {
        case "bool": case "int": case "float": return C(a.v);
        case "str": return { t: "has", i: this.items.eventNamed(a.v), k: 1 };
        case "name": return this.name(a.v, sp, d);
        case "tuple": return this.tuple(a.v, sp, d);
        case "list": return this.opnd(a, sp, d);
        case "call": return this.call(a.n, a.v, sp, d);
        case "index": return this.index(a.n, a.x, sp, d);
        case "not": { const n = this.comp(a.x, sp, d + 1); return n.t === "const" ? C(!truthy(n.v)) : { t: "not", x: n }; }
        case "neg": case "bin": return this.opnd(a, sp, d);
        case "and": return this.boolop(false, a.v, sp, d);
        case "or": return this.boolop(true, a.v, sp, d);
        case "cmp": return this.cmp(a.l, a.r, sp, d);
        case "if": {
          const c = this.comp(a.c, sp, d + 1);
          if (c.t === "const") return truthy(c.v) ? this.comp(a.a, sp, d + 1) : this.comp(a.b, sp, d + 1);
          return { t: "if", c, a: this.comp(a.a, sp, d + 1), b: this.comp(a.b, sp, d + 1) };
        }
      }
      throw new Error("bad ast " + a.t);
    }
    known(n) { return this.setting(n) !== undefined || this.aliases.has(n) || ["age", "at_day", "at_night", "at_dampe_time"].includes(n) || eventLike(n); }
    opnd(a, sp, d) {
      switch (a.t) {
        case "str": return C(a.v);
        case "name": {
          const i = this.items.findEsc(a.v);
          if (i !== undefined && this.setting(a.v) === undefined) return C(this.items.names[i]);
          return this.known(a.v) ? this.comp(a, sp, d + 1) : C(a.v);
        }
        case "tuple": case "list": {
          const out = a.v.map((x) => this.opnd(x, sp, d + 1));
          return out.every((x) => x.t === "const") ? C(out.map((x) => x.v)) : { t: "list", v: out };
        }
        case "neg": {
          const n = this.opnd(a.x, sp, d + 1);
          if (n.t === "const") { if (!isNum(n.v)) throw new Error("cannot negate"); return C(-num(n.v)); }
          return { t: "neg", x: n };
        }
        case "bin": {
          const l = this.opnd(a.a, sp, d + 1), r = this.opnd(a.b, sp, d + 1);
          if (l.t === "const" && r.t === "const") { const v = arith(a.op, l.v, r.v); if (v === undefined) throw new Error("invalid arithmetic"); return C(v); }
          return { t: "bin", op: a.op, a: l, b: r };
        }
      }
      return this.comp(a, sp, d + 1);
    }
    name(n, sp, d) {
      if (n === "at_day" || n === "at_night" || n === "at_dampe_time") return this.tod(n, sp, d);
      if (n === "age") return { t: "age" };
      const al = this.aliases.get(n);
      if (al) { if (al.params.length) throw new Error("expected args for " + n); return this.comp(al.body, sp, d + 1); }
      const i = this.items.findEsc(n);
      if (i !== undefined) return { t: "has", i, k: 1 };
      const s = this.setting(n);
      if (s !== undefined) return C(s);
      if (eventLike(n)) return { t: "has", i: this.items.eventNamed(n.replace(/_/g, " ")), k: 1 };
      this.warn.push("invalid name " + n);
      return C(false);
    }
    tod(w, sp, d) {
      if (!truthy(this.setting("ensure_tod_access"))) return C(true);
      const [flag, skip] = w === "at_day" ? [DAY, "skip_to_day"] : w === "at_night" ? [DAMPE, "skip_to_night"] : [DAMPE, "skip_to_dampe"];
      const sn = this.aliases.has(skip) ? this.comp({ t: "name", v: skip }, sp, d + 1) : C(false);
      return { t: "tod", f: flag, s: sn };
    }
    itemArg(a) {
      if (a.t === "str") return this.items.eventNamed(a.v);
      if (a.t === "name") {
        const i = this.items.findEsc(a.v);
        if (i !== undefined) return i;
        if (eventLike(a.v)) return this.items.eventNamed(a.v.replace(/_/g, " "));
      }
      throw new Error("invalid item " + JSON.stringify(a));
    }
    itemsArg(v) { const flat = v.length === 1 && (v[0].t === "tuple" || v[0].t === "list") ? v[0].v : v; return flat.map((x) => this.itemArg(x)); }
    constInt(a, sp, d) { const n = this.opnd(a, sp, d + 1); if (n.t === "const" && isNum(n.v) && Number.isInteger(num(n.v))) return num(n.v); throw new Error("expected a number"); }
    tuple(v, sp, d) {
      if (v.length !== 2) throw new Error("tuple must have 2 values");
      const i = this.itemArg(v[0]); const k = this.constInt(v[1], sp, d);
      return k <= 0 ? C(true) : { t: "has", i, k };
    }
    at(region, body) {
      const key = region + "\u0000" + JSON.stringify(body);
      if (this.subIx.has(key)) return { t: "has", i: this.subIx.get(key), k: 1 };
      const n = (this.subN.get(region) || 0) + 1; this.subN.set(region, n);
      const name = `${region} Subrule ${n}`;
      const item = this.items.eventNamed(name);
      this.subIx.set(key, item);
      this.subs.push({ region, ast: body, item, name });
      return { t: "has", i: item, k: 1 };
    }
    call(n, v, sp, d) {
      if (n === "at") { if (v[0] && v[0].t === "str" && v[1]) return this.at(v[0].v, v[1]); throw new Error("invalid at()"); }
      if (n === "here") return this.at(sp.region, v[0]);
      if (n === "at_day" || n === "at_night" || n === "at_dampe_time") return this.tod(n, sp, d);
      const al = this.aliases.get(n);
      if (al) {
        if (al.params.length !== v.length) throw new Error(`expected ${al.params.length} args for ${n}`);
        const m = new Map();
        al.params.forEach((p, k) => {
          const x = v[k];
          if (!["name", "str", "int", "float", "bool"].includes(x.t)) throw new Error("invalid argument for " + n);
          m.set(p, x);
        });
        return this.comp(subst(al.body, m), sp, d + 1);
      }
      switch (n) {
        case "has": { const i = this.itemArg(v[0]); const k = v[1] ? this.constInt(v[1], sp, d) : 1; return k <= 0 ? C(true) : { t: "has", i, k }; }
        case "has_any_of": return { t: "any", v: this.itemsArg(v) };
        case "has_all_of": return { t: "all", v: this.itemsArg(v) };
        case "item_count": case "count": return { t: "item", i: this.itemArg(v[0]) };
        case "count_distinct": return { t: "distinct", v: this.itemsArg(v) };
        case "count_group": case "has_group": {
          const g = v[0] && (v[0].t === "name" || v[0].t === "str") ? v[0].v : null;
          const ids = this.groups.get(g) || [];
          if (n === "count_group") return { t: "distinct", v: ids };
          const k = v[1] ? this.constInt(v[1], sp, d) : 1;
          return { t: "cmp", op: ">=", a: { t: "distinct", v: ids }, b: C(k) };
        }
      }
      this.warn.push("unknown function " + n);
      return C(false);
    }
    index(n, x, sp, d) {
      let key;
      if (x.t === "name") key = x.v.replace(/_/g, " ");
      else if (x.t === "str") key = x.v;
      else { const o = this.opnd(x, sp, d + 1); if (o.t === "const" && typeof o.v === "string") key = o.v; else throw new Error("unsupported subscript"); }
      const m = this.setting(n);
      if (m && typeof m === "object" && !Array.isArray(m) && key in m) return C(m[key]);
      this.warn.push(`no key ${key} in ${n}`);
      return C(false);
    }
    boolop(isOr, v, sp, d) {
      const rest = [];
      for (const x of v) {
        const n = this.comp(x, sp, d + 1);
        if (n.t === "const") { if (truthy(n.v) === isOr) return C(isOr); continue; }
        if (isOr && n.t === "or") rest.push(...n.v);
        else if (!isOr && n.t === "and") rest.push(...n.v);
        else rest.push(n);
      }
      if (!rest.length) return C(!isOr);
      if (rest.length === 1) return rest[0];
      return { t: isOr ? "or" : "and", v: rest };
    }
    pair(op, l, r) {
      if (l.t === "const" && r.t === "const") return C(compare(op, l.v, r.v));
      if (op === "==" || op === "!=") {
        let s = null;
        if (l.t === "age" && r.t === "const" && typeof r.v === "string") s = r.v;
        if (r.t === "age" && l.t === "const" && typeof l.v === "string") s = l.v;
        if (s === "adult" || s === "child") { const t = { t: "ageis", a: s }; return op === "==" ? t : { t: "not", x: t }; }
      }
      return { t: "cmp", op, a: l, b: r };
    }
    cmp(l, r, sp, d) {
      if (r.length === 1 && r[0][0] === "==" && l.t === "name" && r[0][1].t === "name" && this.setting(l.v) === undefined && this.setting(r[0][1].v) === undefined) return C(l.v === r[0][1].v);
      let prev = this.opnd(l, sp, d + 1);
      const parts = [];
      for (const [op, x] of r) { const nx = this.opnd(x, sp, d + 1); parts.push(this.pair(op, prev, nx)); prev = nx; }
      if (parts.length === 1) return parts[0];
      const all = [];
      for (const p of parts) { if (p.t === "const") { if (!truthy(p.v)) return C(false); } else all.push(p); }
      return all.length === 0 ? C(true) : all.length === 1 ? all[0] : { t: "and", v: all };
    }
  }

  function collect(n, deps, st) {
    switch (n.t) {
      case "has": case "item": deps.add(n.i); break;
      case "any": case "all": case "distinct": n.v.forEach((i) => deps.add(i)); break;
      case "tod": st.tod = true; collect(n.s, deps, st); break;
      case "not": case "neg": collect(n.x, deps, st); break;
      case "and": case "or": case "list": n.v.forEach((x) => collect(x, deps, st)); break;
      case "cmp": case "bin": collect(n.a, deps, st); collect(n.b, deps, st); break;
      case "if": collect(n.c, deps, st); collect(n.a, deps, st); collect(n.b, deps, st); break;
    }
  }
  function mkRule(node) {
    const deps = new Set(), st = { tod: false };
    collect(node, deps, st);
    return { node, deps: [...deps], tod: st.tod, always: node.t === "const" && truthy(node.v), never: node.t === "const" && !truthy(node.v) };
  }

  // ---------- eval ----------
  function evalN(n, c) {
    switch (n.t) {
      case "const": return truthy(n.v);
      case "has": return c.cnt[n.i] >= n.k;
      case "any": return n.v.some((i) => c.cnt[i] > 0);
      case "all": return n.v.every((i) => c.cnt[i] > 0);
      case "ageis": return c.age === n.a;
      case "tod":
        if (c.tod) return (c.tod & n.f) !== 0;
        if (evalN(n.s, c)) return true;
        if (!c.q) return false;
        if (c.age) return c.q.reachTod(c.region, c.age, n.f);
        return AGES.some((a) => c.q.reachTod(c.region, a, n.f));
      case "not": return !evalN(n.x, c);
      case "and": return n.v.every((x) => evalN(x, c));
      case "or": return n.v.some((x) => evalN(x, c));
    }
    return truthy(value(n, c));
  }
  function value(n, c) {
    switch (n.t) {
      case "const": return n.v;
      case "item": return c.cnt[n.i];
      case "distinct": return n.v.filter((i) => c.cnt[i] > 0).length;
      case "age": return c.age || false;
      case "neg": { const v = value(n.x, c); return isNum(v) ? -num(v) : false; }
      case "bin": { const v = arith(n.op, value(n.a, c), value(n.b, c)); return v === undefined ? false : v; }
      case "cmp": return compare(n.op, value(n.a, c), value(n.b, c));
      case "if": return evalN(n.c, c) ? value(n.a, c) : value(n.b, c);
      case "list": return n.v.map((x) => value(x, c));
    }
    return evalN(n, c);
  }

  // ---------- world (world.rs) ----------
  function loadAliases(obj, map) {
    for (const [k, text] of Object.entries(obj)) {
      let name = k.trim(), params = [];
      const p = k.indexOf("(");
      if (p >= 0) { name = k.slice(0, p).trim(); params = k.slice(p + 1).replace(/\)\s*$/, "").split(",").map((s) => s.trim()).filter(Boolean); }
      map.set(name, { params, body: parse(text) });
    }
  }

  // data: the tracker bundle (regions, patches, helpers, groups, items, root) exported from ootrr-core.
  // switches: logic switches like "rock_spots=on" whose region changes are applied, as spec() does.
  function buildWorld(data, settings, switches = []) {
    const items = new Items();
    for (const [n, adv] of data.items) items.add(n, !!adv);
    const groups = new Map();
    for (const [g, names] of Object.entries(data.groups || {})) groups.set(g, names.map((n) => { const i = items.find(n); if (i === undefined) throw new Error("group item " + n); return i; }));
    const aliases = new Map();
    loadAliases(data.helpers, aliases);
    // Each switch's patch adds, changes or removes single locations, events and exits, so patches
    // of several switches that touch the same region combine.
    let regionList = data.regions;
    if (switches.length) {
      const by = new Map(data.regions.map((r) => [r.n, { ...r, l: { ...(r.l || {}) }, e: { ...(r.e || {}) }, x: { ...(r.x || {}) } }]));
      for (const sw of switches) {
        for (const [n, d] of Object.entries((data.patches || {})[sw] || {})) {
          if (d.new) { if (!by.has(n)) by.set(n, { ...d.new, l: { ...(d.new.l || {}) }, e: { ...(d.new.e || {}) }, x: { ...(d.new.x || {}) } }); continue; }
          const r = by.get(n);
          if (!r) continue;
          for (const f of ["l", "e", "x"]) {
            Object.assign(r[f], d[f] || {});
            for (const k of d[f + "-"] || []) delete r[f][k];
          }
          if ("d" in d) r.d = d.d;
          if ("t" in d) r.t = d.t;
        }
      }
      regionList = [...by.values()];
    }
    const cmp = new Compiler(items, settings, aliases, groups);
    const regions = [], rix = new Map();
    regionList.forEach((r) => { rix.set(r.n, regions.length); regions.push({ name: r.n, dungeon: r.d || null, provides: r.t || 0, locations: [], exits: [] }); });
    const locs = [], lix = new Map(), exits = [];
    regionList.forEach((r, rid) => {
      for (const [n, base] of Object.entries(r.l || {})) {
        // data.loc_fixes: extra requirements the tracker adds to single locations (see Seed.withFixes)
        // data.loc_rules: a rule the tracker uses instead of OOTRR's, where OOTRR's is wrong for the remake
        const more = data.loc_fixes && data.loc_fixes[n], own = data.loc_rules && data.loc_rules[n];
        const text = more ? `(${own || base}) and ${more}` : own || base;
        const rule = cmp.rule(text, { region: r.n, name: n });
        lix.set(n, locs.length); regions[rid].locations.push(locs.length);
        locs.push({ name: n, region: rid, rule, event: null });
      }
      for (const [ev, text] of Object.entries(r.e || {})) {
        const n = `${ev} from ${r.n}`;
        const rule = cmp.rule(text, { region: r.n, name: n });
        const item = items.eventNamed(ev);
        if (rule.never) continue;
        regions[rid].locations.push(locs.length);
        locs.push({ name: n, region: rid, rule, event: item });
      }
      for (const [to, text] of Object.entries(r.x || {})) {
        const n = `${r.n} -> ${to}`;
        const rule = cmp.rule(text, { region: r.n, name: n });
        const tid = rix.get(to);
        if (tid === undefined) throw new Error("unknown region " + to);
        regions[rid].exits.push(exits.length);
        exits.push({ name: n, from: rid, to: tid, rule });
      }
    });
    for (let k = 0; k < cmp.subs.length; k++) {
      const s = cmp.subs[k];
      const rid = rix.get(s.region);
      if (rid === undefined) throw new Error("at(): unknown region " + s.region);
      const rule = cmp.ruleAst(s.ast, { region: s.region, name: s.name });
      if (rule.never) continue;
      regions[rid].locations.push(locs.length);
      locs.push({ name: s.name, region: rid, rule, event: s.item });
    }
    const users = Array.from({ length: items.names.length }, () => []);
    const todUsers = [];
    const ne = exits.length;
    const index = (r, spot) => { r.deps.forEach((i) => users[i].push(spot)); if (r.tod) todUsers.push(spot); };
    exits.forEach((x, e) => index(x.rule, e));
    locs.forEach((l, k) => index(l.rule, ne + k));
    const root = rix.get(data.root || "Root");
    return { regions, exits, locs, items, users, todUsers, root, rix, lix, warn: cmp.warn };
  }

  // ---------- search (search.rs) ----------
  class Search {
    constructor(w, counts) {
      this.w = w;
      const n = w.exits.length + w.locs.length, r = w.regions.length;
      this.cnt = new Array(w.items.names.length).fill(0);
      for (const [i, c] of counts) this.cnt[i] += c;
      this.visited = new Uint8Array(w.locs.length);
      this.reached = [new Uint8Array(r), new Uint8Array(r)];
      this.tods = [new Uint8Array(r), new Uint8Array(r)];
      this.open = [new Uint8Array(n), new Uint8Array(n)];
      this.queued = [new Uint8Array(n), new Uint8Array(n)];
      this.queue = [[], []];
      this.dirty = false;
      this.place = null;
    }
    add(i, n) { this.cnt[i] += n; this.dirty = true; for (const s of this.w.users[i]) for (let a = 0; a < 2; a++) this.push(a, s, false); }
    push(a, s, open) { if (open) this.open[a][s] = 1; if (this.open[a][s] && !this.queued[a][s]) { this.queued[a][s] = 1; this.queue[a].push(s); } }
    wanted(l) { if (this.visited[l]) return false; if (this.w.locs[l].event !== null) return true; const p = this.place[l]; return p !== undefined && p !== null && this.w.items.adv[p]; }
    reach(a, r) {
      if (this.reached[a][r]) return;
      this.reached[a][r] = 1; this.dirty = true;
      const w = this.w;
      this.tods[a][r] = w.regions[r].provides;
      for (const e of w.regions[r].exits) if (!this.reached[a][w.exits[e].to]) this.push(a, e, true);
      const ne = w.exits.length;
      for (const l of w.regions[r].locations) if (this.wanted(l)) this.push(a, ne + l, true);
    }
    test(rule, a, region) {
      if (rule.always) return true;
      if (rule.never) return false;
      return evalN(rule.node, { cnt: this.cnt, age: AGES[a], tod: 0, region, q: this });
    }
    step(a, s) {
      if (!this.open[a][s]) return;
      const w = this.w, ne = w.exits.length;
      if (s < ne) {
        const x = w.exits[s];
        if (this.reached[a][x.to]) { this.open[a][s] = 0; return; }
        if (this.test(x.rule, a, x.from)) { this.open[a][s] = 0; this.reach(a, x.to); }
        return;
      }
      const l = s - ne;
      if (this.visited[l]) { this.open[a][s] = 0; return; }
      const lc = w.locs[l];
      if (!this.test(lc.rule, a, lc.region)) return;
      this.visited[l] = 1; this.open[0][s] = 0; this.open[1][s] = 0; this.dirty = true;
      if (lc.event !== null) this.add(lc.event, 1);
      else { const p = this.place[l]; if (p !== undefined && p !== null) this.add(p, 1); }
    }
    pop() { for (let a = 0; a < 2; a++) { if (this.queue[a].length) { const s = this.queue[a].pop(); this.queued[a][s] = 0; return [a, s]; } } return null; }
    requeueTod() {
      let any = false;
      for (const s of this.w.todUsers) for (let a = 0; a < 2; a++) if (this.open[a][s] && !this.queued[a][s]) { this.push(a, s, false); any = true; }
      return any;
    }
    run(place) {
      this.place = place;
      for (let a = 0; a < 2; a++) this.reach(a, this.w.root);
      for (;;) {
        let p;
        while ((p = this.pop())) this.step(p[0], p[1]);
        if (this.dirty && this.w.todUsers.length) { this.dirty = false; if (this.requeueTod()) continue; }
        break;
      }
      return this;
    }
    locAccess(l, a) {
      const lc = this.w.locs[l];
      const ages = a === undefined ? [0, 1] : [a];
      return ages.some((x) => this.reached[x][lc.region] && this.test(lc.rule, x, lc.region));
    }
    expandTod(goal, a, flag) {
      const w = this.w, t = Uint8Array.from(this.tods[a]);
      const q = [];
      t.forEach((f, r) => { if (f & flag) q.push(...w.regions[r].exits); });
      let hit = false;
      for (let k = 0; k < q.length; k++) {
        const x = w.exits[q[k]];
        if (!this.reached[a][x.to] || (flag & ~t[x.to]) === 0) continue;
        const ok = x.rule.always || (!x.rule.never && evalN(x.rule.node, { cnt: this.cnt, age: AGES[a], tod: flag, region: x.from, q: null }));
        if (ok) { t[x.to] |= flag; if (x.to === goal) { hit = true; break; } q.push(...w.regions[x.to].exits); }
      }
      this.tods[a] = t;
      return hit;
    }
    reachTod(region, age, flag) {
      const a = AGES.indexOf(age);
      if (!this.reached[a][region]) return false;
      if (this.tods[a][region] & flag) return true;
      return this.expandTod(region, a, flag);
    }
  }

  return { parse, buildWorld, Search, escape };
})();
if (typeof module !== "undefined") module.exports = Engine;
