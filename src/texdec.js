// Game texture reading for the map tracker: zstd frames, BNTX texture files, Tegra block-linear
// swizzling and ASTC blocks. The BNTX, swizzle and ASTC parts are ported from realazk/ootrr
// (crates/core/src/tex: bntx.rs, swizzle.rs, surface.rs, astc.rs; GPL-3.0). The zstd part follows the
// format specification (RFC 8878) and handles frames without a dictionary, which is what the game uses
// for its map textures.
const TexDec = (() => {
  "use strict";

  // ---------- zstd ----------
  const ZMAGIC = 0xfd2fb528;
  const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ML_BASE = [], ML_BITS = [];
  for (let i = 0; i < 32; i++) { ML_BASE.push(i + 3); ML_BITS.push(0); }
  [[35, 1], [37, 1], [39, 1], [41, 1], [43, 2], [47, 2], [51, 3], [59, 3], [67, 4], [83, 4], [99, 5], [131, 7], [259, 8], [515, 9], [1027, 10], [2051, 11], [4099, 12], [8195, 13], [16387, 14], [32771, 15], [65539, 16]]
    .forEach(([b, n]) => { ML_BASE.push(b); ML_BITS.push(n); });
  const LL_DEF = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
  const ML_DEF = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
  const OF_DEF = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
  const zerr = (m) => { throw new Error("zstd: " + m); };
  const highbit = (v) => 31 - Math.clz32(v);

  // bits read upward from bit `pos` of `b` (little-endian), n <= 25
  function fwd(b, pos, n) {
    let o = pos >> 3, v = 0;
    for (let i = 0; i < 4; i++) v |= (o + i < b.length ? b[o + i] : 0) << (8 * i);
    return ((v >>> (pos & 7)) & ((1 << n) - 1)) >>> 0;
  }
  // A backward bit stream (FSE/Huffman): bits are consumed from the end toward the start.
  class Back {
    constructor(b, start, end) {
      this.b = b; this.start = start;
      const last = b[end - 1];
      if (!last) zerr("a bit stream has no end marker");
      this.pos = (end - start - 1) * 8 + highbit(last); // bits left
    }
    read(n) {
      if (!n) return 0;
      this.pos -= n;
      const p = this.pos;
      if (p >= 0) return this.get(p, n);
      // past the start: the missing low bits are zeros
      if (p + n <= 0) return 0;
      return this.get(0, p + n) << -p;
    }
    get(p, n) {
      // n <= 25: read up to 4 bytes from start + (p >> 3)
      const o = this.start + (p >> 3), b = this.b;
      let v = 0;
      for (let i = 0; i < 4; i++) { const k = o + i; v |= (k < b.length ? b[k] : 0) << (8 * i); }
      return ((v >>> (p & 7)) & ((1 << n) - 1)) >>> 0;
    }
  }
  // FSE table from normalized counts
  function fseTable(norm, al) {
    const size = 1 << al, sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size);
    let high = size - 1;
    const next = new Uint16Array(norm.length);
    for (let s = 0; s < norm.length; s++) {
      if (norm[s] === -1) { sym[high--] = s; next[s] = 1; } else next[s] = norm[s];
    }
    const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
    let pos = 0;
    for (let s = 0; s < norm.length; s++) {
      for (let i = 0; i < norm[s]; i++) {
        sym[pos] = s;
        do pos = (pos + step) & mask; while (pos > high);
      }
    }
    if (pos) zerr("bad FSE table");
    for (let i = 0; i < size; i++) {
      const s = sym[i], ns = next[s]++;
      nb[i] = al - highbit(ns);
      base[i] = (ns << nb[i]) - size;
    }
    return { al, sym, nb, base };
  }
  // normalized counts header: returns [table, bytes used]
  function readNCount(b, o, maxSym, maxAl) {
    let bp = o * 8;
    const al = fwd(b, bp, 4) + 5; bp += 4;
    if (al > maxAl) zerr("FSE accuracy too high");
    let remaining = (1 << al) + 1, threshold = 1 << al, nbits = al + 1, s = 0, prev0 = false;
    const norm = [];
    while (remaining > 1 && s <= maxSym) {
      if (prev0) {
        for (;;) {
          const r = fwd(b, bp, 2); bp += 2;
          for (let k = 0; k < r; k++) norm[s++] = 0;
          if (r !== 3) break;
        }
        if (s > maxSym) break;
      }
      const max = (2 * threshold - 1) - remaining;
      const v = fwd(b, bp, nbits);
      let count;
      if ((v & (threshold - 1)) < max) { count = v & (threshold - 1); bp += nbits - 1; }
      else { count = v & (2 * threshold - 1); if (count >= threshold) count -= max; bp += nbits; }
      count--;
      remaining -= Math.abs(count);
      norm[s++] = count;
      prev0 = count === 0;
      while (remaining < threshold) { nbits--; threshold >>= 1; }
    }
    if (remaining !== 1) zerr("bad FSE counts");
    return [fseTable(norm, al), ((bp + 7) >> 3) - o];
  }
  function rleTable(s) { return { al: 0, sym: Uint8Array.of(s), nb: Uint8Array.of(0), base: Uint16Array.of(0) }; }

  // Huffman literal table: returns [table, bytes used]
  function readHuff(b, o) {
    const hb = b[o];
    const w = [];
    let used;
    if (hb < 128) {
      // FSE-compressed weights
      const [t, n] = readNCount(b, o + 1, 255, 6);
      const bs = new Back(b, o + 1 + n, o + 1 + hb);
      let s1 = bs.read(t.al), s2 = bs.read(t.al);
      for (;;) {
        w.push(t.sym[s1]); s1 = t.base[s1] + bs.read(t.nb[s1]);
        if (bs.pos < 0) { w.push(t.sym[s2]); break; }
        w.push(t.sym[s2]); s2 = t.base[s2] + bs.read(t.nb[s2]);
        if (bs.pos < 0) { w.push(t.sym[s1]); break; }
        if (w.length > 255) zerr("too many Huffman weights");
      }
      used = 1 + hb;
    } else {
      const n = hb - 127;
      for (let i = 0; i < n; i++) { const byte = b[o + 1 + (i >> 1)]; w.push(i & 1 ? byte & 15 : byte >> 4); }
      used = 1 + ((n + 1) >> 1);
    }
    let total = 0;
    for (const x of w) if (x) total += 1 << (x - 1);
    if (!total) zerr("empty Huffman table");
    const maxBits = highbit(total) + 1, left = (1 << maxBits) - total;
    if (left & (left - 1)) zerr("bad Huffman weights");
    w.push(highbit(left) + 1);
    const size = 1 << maxBits, sym = new Uint8Array(size), nb = new Uint8Array(size);
    const bits = w.map((x) => (x ? maxBits + 1 - x : 0));
    const rankCount = new Array(maxBits + 2).fill(0), rankIdx = new Array(maxBits + 2).fill(0);
    for (const x of bits) if (x) rankCount[x]++;
    rankIdx[maxBits] = 0;
    for (let i = maxBits; i >= 1; i--) {
      rankIdx[i - 1] = rankIdx[i] + rankCount[i] * (1 << (maxBits - i));
      nb.fill(i, rankIdx[i], rankIdx[i - 1]);
    }
    for (let s = 0; s < bits.length; s++) {
      if (!bits[s]) continue;
      const len = 1 << (maxBits - bits[s]);
      sym.fill(s, rankIdx[bits[s]], rankIdx[bits[s]] + len);
      rankIdx[bits[s]] += len;
    }
    return [{ maxBits, sym, nb }, used];
  }
  function huffStream(b, start, end, t, out, op, n) {
    const bs = new Back(b, start, end), mask = (1 << t.maxBits) - 1;
    let st = bs.read(t.maxBits);
    for (let i = 0; i < n; i++) {
      out[op + i] = t.sym[st];
      const k = t.nb[st];
      st = ((st << k) & mask) | bs.read(k);
    }
  }

  function decompress(b) {
    let o = 0;
    const parts = [];
    while (o < b.length) {
      const magic = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { // skippable frame
        const n = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24)) >>> 0;
        o += 8 + n; continue;
      }
      if (magic !== ZMAGIC) zerr("bad magic");
      const r = frame(b, o + 4);
      parts.push(r.out); o = r.end;
    }
    if (parts.length === 1) return parts[0];
    const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let k = 0; for (const p of parts) { all.set(p, k); k += p.length; }
    return all;
  }
  function frame(b, o) {
    const fhd = b[o++];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, check = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) o++; // window descriptor
    if (dictFlag) { const n = [0, 1, 2, 4][dictFlag]; let id = 0; for (let i = 0; i < n; i++) id |= b[o + i] << (8 * i); o += n; if (id) zerr("dictionaries are not supported"); }
    const fn = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let fcs = -1;
    if (fn) { fcs = 0; for (let i = 0; i < Math.min(fn, 6); i++) fcs += b[o + i] * 2 ** (8 * i); if (fn === 2) fcs += 256; o += fn; }
    let out = new Uint8Array(fcs >= 0 ? fcs : 1 << 20), op = 0;
    const need = (n) => { if (op + n > out.length) { const g = new Uint8Array(Math.max(out.length * 2, op + n)); g.set(out.subarray(0, op)); out = g; } };
    const st = { reps: [1, 4, 8], huff: null, ll: null, of: null, ml: null };
    for (;;) {
      const h = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); o += 3;
      const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
      if (type === 0) { need(size); out.set(b.subarray(o, o + size), op); op += size; o += size; }
      else if (type === 1) { need(size); out.fill(b[o], op, op + size); op += size; o += 1; }
      else if (type === 2) {
        const r = block(b, o, o + size, st, out, op, need, () => out);
        out = r.out; op = r.op; o += size;
      } else zerr("reserved block type");
      if (last) break;
    }
    if (check) o += 4;
    return { out: op === out.length ? out : out.slice(0, op), end: o };
  }
  function block(b, o, end, st, out0, op, need, cur) {
    // literals
    const b0 = b[o], ltype = b0 & 3, sf = (b0 >> 2) & 3;
    let lits, regen, csize, hdr, streams = 1;
    if (ltype < 2) {
      if (sf === 0 || sf === 2) { regen = b0 >> 3; hdr = 1; }
      else if (sf === 1) { regen = (b0 >> 4) + (b[o + 1] << 4); hdr = 2; }
      else { regen = (b0 >> 4) + (b[o + 1] << 4) + (b[o + 2] << 12); hdr = 3; }
      if (ltype === 0) { lits = b.subarray(o + hdr, o + hdr + regen); o += hdr + regen; }
      else { lits = new Uint8Array(regen).fill(b[o + hdr]); o += hdr + 1; }
    } else {
      if (sf < 2) { const v = b0 | (b[o + 1] << 8) | (b[o + 2] << 16); regen = (v >> 4) & 0x3ff; csize = (v >> 14) & 0x3ff; hdr = 3; streams = sf === 0 ? 1 : 4; }
      else if (sf === 2) { const v = (b0 | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; regen = (v >>> 4) & 0x3fff; csize = v >>> 18; hdr = 4; streams = 4; }
      else { regen = (b0 >> 4) | (b[o + 1] << 4) | ((b[o + 2] & 0x3f) << 12); csize = (b[o + 2] >> 6) | (b[o + 3] << 2) | (b[o + 4] << 10); hdr = 5; streams = 4; }
      let p = o + hdr;
      const cend = p + csize;
      if (ltype === 2) { const [t, n] = readHuff(b, p); st.huff = t; p += n; }
      else if (!st.huff) zerr("treeless literals without a table");
      lits = new Uint8Array(regen);
      if (streams === 1) huffStream(b, p, cend, st.huff, lits, 0, regen);
      else {
        const s1 = b[p] | (b[p + 1] << 8), s2 = b[p + 2] | (b[p + 3] << 8), s3 = b[p + 4] | (b[p + 5] << 8);
        const q = (regen + 3) >> 2;
        let a = p + 6;
        huffStream(b, a, a + s1, st.huff, lits, 0, q); a += s1;
        huffStream(b, a, a + s2, st.huff, lits, q, q); a += s2;
        huffStream(b, a, a + s3, st.huff, lits, 2 * q, q); a += s3;
        huffStream(b, a, cend, st.huff, lits, 3 * q, regen - 3 * q);
      }
      o = cend;
    }
    // sequences
    let nseq = b[o++];
    if (nseq >= 128) {
      if (nseq < 255) nseq = ((nseq - 128) << 8) + b[o++];
      else { nseq = b[o] + (b[o + 1] << 8) + 0x7f00; o += 2; }
    }
    let out = out0;
    if (!nseq) { need(lits.length); out = cur(); out.set(lits, op); return { out, op: op + lits.length }; }
    const modes = b[o++];
    const pick = (mode, def, defAl, maxSym, maxAl, prev) => {
      if (mode === 0) return fseTable(def, defAl);
      if (mode === 1) return rleTable(b[o++]);
      if (mode === 2) { const [t, n] = readNCount(b, o, maxSym, maxAl); o += n; return t; }
      if (!prev) zerr("repeated sequence table without a previous one");
      return prev;
    };
    st.ll = pick(modes >> 6, LL_DEF, 6, 35, 9, st.ll);
    st.of = pick((modes >> 4) & 3, OF_DEF, 5, 31, 8, st.of);
    st.ml = pick((modes >> 2) & 3, ML_DEF, 6, 52, 9, st.ml);
    const bs = new Back(b, o, end);
    const LL = st.ll, OF = st.of, ML = st.ml, reps = st.reps;
    let sl = bs.read(LL.al), so = bs.read(OF.al), sm = bs.read(ML.al);
    let lp = 0;
    for (let i = 0; i < nseq; i++) {
      const ofc = OF.sym[so], mlc = ML.sym[sm], llc = LL.sym[sl];
      let ofv = ofc > 0 ? (2 ** ofc) + bs.read(ofc) : 1;
      if (ofc > 24) zerr("offset too large");
      const ml = ML_BASE[mlc] + bs.read(ML_BITS[mlc]);
      const ll = LL_BASE[llc] + bs.read(LL_BITS[llc]);
      let off;
      if (ofv > 3) { off = ofv - 3; reps[2] = reps[1]; reps[1] = reps[0]; reps[0] = off; }
      else {
        const idx = ll === 0 ? ofv + 1 : ofv;
        if (idx === 1) off = reps[0];
        else if (idx === 2) { off = reps[1]; reps[1] = reps[0]; reps[0] = off; }
        else if (idx === 3) { off = reps[2]; reps[2] = reps[1]; reps[1] = reps[0]; reps[0] = off; }
        else { off = reps[0] - 1; reps[2] = reps[1]; reps[1] = reps[0]; reps[0] = off; }
      }
      if (i < nseq - 1) {
        sl = LL.base[sl] + bs.read(LL.nb[sl]);
        sm = ML.base[sm] + bs.read(ML.nb[sm]);
        so = OF.base[so] + bs.read(OF.nb[so]);
      }
      need(ll + ml); out = cur();
      for (let k = 0; k < ll; k++) out[op++] = lits[lp++];
      if (off > op || !off) zerr("match before the start");
      let from = op - off;
      for (let k = 0; k < ml; k++) out[op++] = out[from++];
    }
    const rest = lits.length - lp;
    need(rest); out = cur();
    out.set(lits.subarray(lp), op); op += rest;
    return { out, op };
  }

  // ---------- BNTX ----------
  const terr = (m) => { throw new Error("bntx: " + m); };
  function bntx(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = (o) => dv.getUint32(o, true), u16 = (o) => dv.getUint16(o, true);
    const ptr = (o) => { const v = Number(dv.getBigUint64(o, true)); if (v >= b.length) terr("a pointer leaves the file"); return v; };
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "BNTX") terr("bad magic");
    const n = u32(0x24), arr = ptr(0x28), out = [];
    for (let i = 0; i < n; i++) {
      const o = ptr(arr + 8 * i);
      if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) !== "BRTI") terr("no BRTI tag");
      const np = ptr(o + 0x60), nl = u16(np);
      out.push({
        name: new TextDecoder().decode(b.subarray(np + 2, np + 2 + nl)),
        fmt: u32(o + 0x1c), w: u32(o + 0x24), h: u32(o + 0x28),
        gobs: 1 << (u32(o + 0x34) & 7), off: ptr(ptr(o + 0x70)), size: u32(o + 0x50),
      });
    }
    return out;
  }
  // Tegra block-linear address of a 16-byte block
  function addr(x, y, wb, gobs) {
    const stride = Math.ceil(wb / 4), rob = 8 * gobs;
    return Math.floor(y / rob) * 512 * gobs * stride + (x >> 2) * 512 * gobs + Math.floor((y % rob) / 8) * 512
      + (y & 1) * 16 + ((y >> 1) & 1) * 32 + (x & 1) * 64 + ((y >> 2) & 1) * 128 + ((x >> 1) & 1) * 256;
  }
  const ASTC_CELLS = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];
  // decode one texture to RGBA
  function surface(b, t) {
    const k = t.fmt >> 8;
    if (PLAIN[k]) return plain(b, t, PLAIN[k]);
    if (k === 0x1d) return bc4(b, t);
    if (k < 0x2d || k > 0x3a) terr(`texture ${t.name} has format ${t.fmt.toString(16)}, which is not read`);
    const [cw, ch] = ASTC_CELLS[k - 0x2d], srgb = (t.fmt & 0xff) === 6;
    const wb = Math.ceil(t.w / cw), hb = Math.ceil(t.h / ch);
    const data = b.subarray(t.off);
    const rgba = new Uint8ClampedArray(t.w * t.h * 4);
    const px = new Uint8Array(144 * 4), blk = new Uint8Array(16);
    for (let by = 0; by < hb; by++) {
      for (let bx = 0; bx < wb; bx++) {
        const a = addr(bx, by, wb, t.gobs);
        for (let i = 0; i < 16; i++) blk[i] = data[a + i];
        if (!astcBlock(blk, cw, ch, srgb, px)) for (let i = 0; i < cw * ch; i++) px.set(BAD, i * 4);
        for (let yy = 0; yy < ch; yy++) {
          const y = by * ch + yy;
          if (y >= t.h) break;
          for (let xx = 0; xx < cw; xx++) {
            const x = bx * cw + xx;
            if (x >= t.w) break;
            const s = (yy * cw + xx) * 4, d = (y * t.w + x) * 4;
            rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3];
          }
        }
      }
    }
    return { w: t.w, h: t.h, rgba };
  }

  // uncompressed formats: bytes per pixel and how to spread the channels into RGBA
  const PLAIN = {
    0x02: [1, (s, o) => [s[o], s[o], s[o], 255]],               // R8
    0x09: [2, (s, o) => [s[o], s[o + 1], 0, 255]],              // R8G8
    0x0b: [4, (s, o) => [s[o], s[o + 1], s[o + 2], s[o + 3]]],  // R8G8B8A8
    0x0c: [4, (s, o) => [s[o + 2], s[o + 1], s[o], s[o + 3]]],  // B8G8R8A8
  };
  function plain(b, t, [n, px]) {
    const data = b.subarray(t.off), per = 16 / n, wide = Math.ceil(t.w / per);
    const rgba = new Uint8ClampedArray(t.w * t.h * 4);
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const a = addr((x / per) | 0, y, wide, t.gobs) + (x % per) * n;
        rgba.set(px(data, a), (y * t.w + x) * 4);
      }
    }
    return { w: t.w, h: t.h, rgba };
  }

  // BC4: one channel in 8-byte 4x4 blocks, shown as grey
  function bc4(b, t) {
    const data = b.subarray(t.off), wb = Math.ceil(t.w / 4), hb = Math.ceil(t.h / 4), wide = Math.ceil(wb / 2);
    const rgba = new Uint8ClampedArray(t.w * t.h * 4), pal = new Uint8Array(8);
    for (let by = 0; by < hb; by++) {
      for (let bx = 0; bx < wb; bx++) {
        const a = addr(bx >> 1, by, wide, t.gobs) + (bx & 1) * 8;
        const r0 = data[a], r1 = data[a + 1];
        pal[0] = r0; pal[1] = r1;
        if (r0 > r1) for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * r0 + i * r1) / 7;
        else { for (let i = 1; i < 5; i++) pal[i + 1] = ((5 - i) * r0 + i * r1) / 5; pal[6] = 0; pal[7] = 255; }
        let lo = data[a + 2] | (data[a + 3] << 8) | (data[a + 4] << 16), hi = data[a + 5] | (data[a + 6] << 8) | (data[a + 7] << 16);
        for (let i = 0; i < 16; i++) {
          const idx = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
          const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
          if (x < t.w && y < t.h) { const d = (y * t.w + x) * 4, v = pal[idx]; rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; rgba[d + 3] = 255; }
        }
      }
    }
    return { w: t.w, h: t.h, rgba };
  }

  // ---------- ASTC ----------
  const BAD = [255, 0, 255, 255];
  const WEIGHT_LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];
  const COLOR_LEVELS = [256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6];
  const BITS = 0, TRIT = 1, QUINT = 2;
  const LEVEL = { 2: [1, BITS], 3: [0, TRIT], 4: [2, BITS], 5: [0, QUINT], 6: [1, TRIT], 8: [3, BITS], 10: [1, QUINT], 12: [2, TRIT], 16: [4, BITS], 20: [2, QUINT], 24: [3, TRIT], 32: [5, BITS], 40: [3, QUINT], 48: [4, TRIT], 64: [6, BITS], 80: [4, QUINT], 96: [5, TRIT], 128: [7, BITS], 160: [5, QUINT], 192: [6, TRIT], 256: [8, BITS] };
  const level = (n) => LEVEL[n] || [8, BITS];
  function iseBits(count, lv) {
    const [b, k] = level(lv);
    return count * b + (k === BITS ? 0 : k === TRIT ? Math.floor((8 * count + 4) / 5) : Math.floor((7 * count + 2) / 3));
  }
  // 128-bit value as four little-endian u32 words
  function rd(w, pos, n) {
    if (!n || pos >= 128) return 0;
    const i = pos >> 5, s = pos & 31;
    let v = w[i] >>> s;
    if (s && i + 1 < 4) v |= w[i + 1] << (32 - s);
    if (n < 32) v &= (1 << n) - 1;
    return v >>> 0;
  }
  const rev32 = (v) => {
    v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
    v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
    v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
    v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
    return ((v >>> 16) | (v << 16)) >>> 0;
  };
  function maskTo(w, n) {
    for (let i = 0; i < 4; i++) {
      const lo = i * 32;
      if (n <= lo) w[i] = 0;
      else if (n < lo + 32) w[i] = (w[i] & ((1 << (n - lo)) - 1)) >>> 0;
    }
    return w;
  }
  function shr(w, s) {
    const o = new Uint32Array(4), q = s >> 5, r = s & 31;
    for (let i = 0; i < 4; i++) {
      const a = i + q < 4 ? w[i + q] : 0, b = i + q + 1 < 4 ? w[i + q + 1] : 0;
      o[i] = r ? ((a >>> r) | (b << (32 - r))) >>> 0 : a;
    }
    return o;
  }
  function trits(t) {
    let c, t4, t3;
    if (((t >> 2) & 7) === 7) { c = (((t >> 5) & 7) << 2) | (t & 3); t4 = 2; t3 = 2; }
    else { c = t & 0x1f; if (((t >> 5) & 3) === 3) { t4 = 2; t3 = (t >> 7) & 1; } else { t4 = (t >> 7) & 1; t3 = (t >> 5) & 3; } }
    let t2, t1, t0;
    if ((c & 3) === 3) { t2 = 2; t1 = (c >> 4) & 1; const c3 = (c >> 3) & 1, c2 = (c >> 2) & 1; t0 = (c3 << 1) | (c2 & (1 - c3)); }
    else if (((c >> 2) & 3) === 3) { t2 = 2; t1 = 2; t0 = c & 3; }
    else { t2 = (c >> 4) & 1; t1 = (c >> 2) & 3; const c1 = (c >> 1) & 1, c0 = c & 1; t0 = (c1 << 1) | (c0 & (1 - c1)); }
    return [t0, t1, t2, t3, t4];
  }
  function quints(q) {
    const bit = (i) => (q >> i) & 1;
    if (((q >> 1) & 3) === 3 && ((q >> 5) & 3) === 0) {
      return [4, 4, (bit(0) << 2) | ((bit(4) & (1 - bit(0))) << 1) | (bit(3) & (1 - bit(0)))];
    }
    let q2, c;
    if (((q >> 1) & 3) === 3) { q2 = 4; c = (((q >> 3) & 3) << 3) | ((3 - ((q >> 5) & 3)) << 1) | bit(0); }
    else { q2 = (q >> 5) & 3; c = q & 0x1f; }
    return (c & 7) === 5 ? [(c >> 3) & 3, 4, q2] : [c & 7, (c >> 3) & 3, q2];
  }
  // integer sequence decoding into d[] (trit/quint digit) and m[] (low bits)
  function ise(w, count, lv, d, m) {
    const [b, k] = level(lv);
    let pos = 0, i = 0;
    if (k === BITS) { for (let j = 0; j < count; j++) { d[j] = 0; m[j] = rd(w, j * b, b); } return; }
    if (k === TRIT) {
      const tn = [2, 2, 1, 2, 1], ms = [0, 0, 0, 0, 0];
      while (i < count) {
        let t = 0, tb = 0;
        for (let j = 0; j < 5; j++) { ms[j] = rd(w, pos, b); pos += b; t |= rd(w, pos, tn[j]) << tb; pos += tn[j]; tb += tn[j]; }
        const ds = trits(t);
        for (let j = 0; j < Math.min(5, count - i); j++) { d[i + j] = ds[j]; m[i + j] = ms[j]; }
        i += 5;
      }
      return;
    }
    const qn = [3, 2, 2], ms = [0, 0, 0];
    while (i < count) {
      let q = 0, qb = 0;
      for (let j = 0; j < 3; j++) { ms[j] = rd(w, pos, b); pos += b; q |= rd(w, pos, qn[j]) << qb; pos += qn[j]; qb += qn[j]; }
      const ds = quints(q);
      for (let j = 0; j < Math.min(3, count - i); j++) { d[i + j] = ds[j]; m[i + j] = ms[j]; }
      i += 3;
    }
  }
  function bitpat(pat, v) {
    let r = 0;
    for (let i = 0; i < pat.length; i++) { r <<= 1; const ch = pat.charCodeAt(i); if (ch !== 48) r |= (v >> (ch - 97)) & 1; }
    return r;
  }
  function spread(v, b, to) {
    let have = 0, out = 0;
    while (have < to) { const take = Math.min(b, to - have); out = (out << take) | (v >> (b - take)); have += take; }
    return out;
  }
  function colorTable(b, k) {
    if (k === TRIT) return [[0, 0], ["000000000", 204], ["b000b0bb0", 93], ["cb000cbcb", 44], ["dcb000dcb", 22], ["edcb000ed", 11]][b] || ["fedcb000f", 5];
    return [[0, 0], ["000000000", 113], ["b0000bb00", 54], ["cb000cbc0", 26], ["dcb0000dc", 13]][b] || ["edcb0000e", 6];
  }
  function unqColor(d, v, lv) {
    const [b, k] = level(lv);
    if (k === BITS) return spread(v, b, 8);
    const [pat, c] = colorTable(b, k);
    const a = v & 1 ? 0x1ff : 0;
    const t = (d * c + bitpat(pat, v)) ^ a;
    return ((a & 0x80) | (t >> 2)) & 0xff;
  }
  function unqWeight(d, v, lv) {
    const [b, k] = level(lv);
    let t;
    if (k === BITS) t = spread(v, b, 6);
    else if (b === 0) return d * (k === TRIT ? 32 : 16);
    else {
      const [pat, c] = k === TRIT ? (b === 1 ? ["0000000", 50] : b === 2 ? ["b000b0b", 23] : ["cb000cb", 11]) : (b === 1 ? ["0000000", 28] : ["b0000b0", 13]);
      const a = v & 1 ? 0x7f : 0;
      t = (a & 0x20) | (((d * c + bitpat(pat, v)) ^ a) >> 2);
    }
    return t > 32 ? t + 1 : t;
  }
  function hash52(p) {
    p >>>= 0;
    p ^= p >>> 15; p = (p - (p << 17)) >>> 0; p = (p + (p << 7)) >>> 0; p = (p + (p << 4)) >>> 0;
    p ^= p >>> 5; p = (p + (p << 16)) >>> 0; p ^= p >>> 7; p ^= p >>> 3; p = (p ^ (p << 6)) >>> 0; p ^= p >>> 17;
    return p >>> 0;
  }
  function partition(seed, x, y, pc, small) {
    if (small) { x <<= 1; y <<= 1; }
    seed = seed + (pc - 1) * 1024;
    const r = hash52(seed);
    const s = [r & 0xf, (r >>> 4) & 0xf, (r >>> 8) & 0xf, (r >>> 12) & 0xf, (r >>> 16) & 0xf, (r >>> 20) & 0xf, (r >>> 24) & 0xf, (r >>> 28) & 0xf, (r >>> 18) & 0xf, (r >>> 22) & 0xf, (r >>> 26) & 0xf, ((r >>> 30) | (r << 2)) & 0xf];
    for (let i = 0; i < 12; i++) s[i] *= s[i];
    let sh1, sh2;
    if (seed & 1) { sh1 = seed & 2 ? 4 : 5; sh2 = pc === 3 ? 6 : 5; } else { sh1 = pc === 3 ? 6 : 5; sh2 = seed & 2 ? 4 : 5; }
    const sh3 = seed & 0x10 ? sh1 : sh2;
    for (let i = 0; i < 12; i++) s[i] >>= i >= 8 ? sh3 : i % 2 === 0 ? sh1 : sh2;
    const a = (s[0] * x + s[1] * y + (r >>> 14)) & 0x3f, b = (s[2] * x + s[3] * y + (r >>> 10)) & 0x3f;
    const c = pc < 3 ? 0 : (s[4] * x + s[5] * y + (r >>> 6)) & 0x3f, d = pc < 4 ? 0 : (s[6] * x + s[7] * y + (r >>> 2)) & 0x3f;
    if (a >= b && a >= c && a >= d) return 0;
    if (b >= c && b >= d) return 1;
    return c >= d ? 2 : 3;
  }
  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  function bts(a, b) { b = (b >> 1) | (a & 0x80); a = (a >> 1) & 0x3f; if (a & 0x20) a -= 0x40; return [a, b]; }
  const blue = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[2]) >> 1, c[2], c[3]];
  function endpoints(cem, v) {
    switch (cem) {
      case 0: return [[v[0], v[0], v[0], 255], [v[1], v[1], v[1], 255]];
      case 1: { const l0 = (v[0] >> 2) | (v[1] & 0xc0), l1 = clamp8(l0 + (v[1] & 0x3f)); return [[l0, l0, l0, 255], [l1, l1, l1, 255]]; }
      case 4: return [[v[0], v[0], v[0], v[2]], [v[1], v[1], v[1], v[3]]];
      case 5: { const [a1, a0] = bts(v[1], v[0]), [a3, a2] = bts(v[3], v[2]), l1 = clamp8(a0 + a1); return [[a0, a0, a0, a2], [l1, l1, l1, clamp8(a2 + a3)]]; }
      case 6: case 10: {
        const al0 = cem === 10 ? v[4] : 255, al1 = cem === 10 ? v[5] : 255;
        return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, al0], [v[0], v[1], v[2], al1]];
      }
      case 8: case 12: {
        const al0 = cem === 12 ? v[6] : 255, al1 = cem === 12 ? v[7] : 255;
        if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) return [[v[0], v[2], v[4], al0], [v[1], v[3], v[5], al1]];
        return [blue([v[1], v[3], v[5], al1]), blue([v[0], v[2], v[4], al0])];
      }
      case 9: case 13: {
        const [o0, b0] = bts(v[1], v[0]), [o1, b1] = bts(v[3], v[2]), [o2, b2] = bts(v[5], v[4]);
        const [oa, ba] = cem === 13 ? bts(v[7], v[6]) : [0, 255];
        const e0 = [b0, b1, b2, ba], e1 = [clamp8(b0 + o0), clamp8(b1 + o1), clamp8(b2 + o2), clamp8(ba + oa)];
        return o0 + o1 + o2 < 0 ? [blue(e1), blue(e0)] : [e0, e1];
      }
      default: return null;
    }
  }
  function blockMode(m) {
    let base = (m >> 4) & 1, high = (m >> 9) & 1, dual = ((m >> 10) & 1) !== 0;
    const a = (m >> 5) & 3;
    let xw, yw;
    if (m & 3) {
      base |= (m & 3) << 1;
      const b = (m >> 7) & 3;
      switch ((m >> 2) & 3) {
        case 0: xw = b + 4; yw = a + 2; break;
        case 1: xw = b + 8; yw = a + 2; break;
        case 2: xw = a + 2; yw = b + 8; break;
        default: if (m & 0x100) { xw = (b & 1) + 2; yw = a + 2; } else { xw = a + 2; yw = (b & 1) + 6; }
      }
    } else {
      base |= ((m >> 2) & 3) << 1;
      if (((m >> 2) & 3) === 0) return null;
      const b = (m >> 9) & 3;
      switch ((m >> 7) & 3) {
        case 0: xw = 12; yw = a + 2; break;
        case 1: xw = a + 2; yw = 12; break;
        case 2: dual = false; high = 0; xw = a + 6; yw = b + 6; break;
        default: if (a === 0) { xw = 6; yw = 10; } else if (a === 1) { xw = 10; yw = 6; } else return null;
      }
    }
    if (base < 2) return null;
    return [xw, yw, dual, WEIGHT_LEVELS[(base - 2) + 6 * high]];
  }
  function infill(wts, plane, planes, xw, yw, bw, bh, out) {
    const ds = Math.floor((1024 + (bw >> 1)) / Math.max(1, bw - 1)), dt = Math.floor((1024 + (bh >> 1)) / Math.max(1, bh - 1));
    const n = xw * yw, g = (i) => wts[Math.min(i, n - 1) * planes + plane];
    for (let t = 0; t < bh; t++) {
      for (let s = 0; s < bw; s++) {
        const gs = (ds * s * (xw - 1) + 32) >> 6, gt = (dt * t * (yw - 1) + 32) >> 6;
        const js = gs >> 4, fs = gs & 15, jt = gt >> 4, ft = gt & 15;
        const v0 = js + jt * xw, w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 + w11 - fs - ft;
        const right = js + 1 < xw, down = jt + 1 < yw;
        const p00 = g(v0), p01 = right ? g(v0 + 1) : p00, p10 = down ? g(v0 + xw) : p00;
        const p11 = right && down ? g(v0 + xw + 1) : right ? p01 : p10;
        out[t * bw + s] = (p00 * w00 + p01 * w01 + p10 * w10 + p11 * w11 + 8) >> 4;
      }
    }
  }
  const W = new Uint32Array(4), RD = new Uint32Array(64), RM = new Uint32Array(64), WTS = new Uint32Array(64);
  const CD = new Uint32Array(64), CM = new Uint32Array(64), CV = new Int32Array(18), W0 = new Uint32Array(144), W1 = new Uint32Array(144);
  // decode one 16-byte block into out (RGBA bytes, bw*bh texels); false when the block is not valid
  function astcBlock(data, bw, bh, srgb, out) {
    const texels = bw * bh;
    for (let i = 0; i < 4; i++) W[i] = (data[4 * i] | (data[4 * i + 1] << 8) | (data[4 * i + 2] << 16) | (data[4 * i + 3] << 24)) >>> 0;
    const m = rd(W, 0, 11);
    if ((m & 0x1ff) === 0x1fc) {
      if ((m >> 9) & 1) return false;
      const c = [rd(W, 64, 16) >> 8, rd(W, 80, 16) >> 8, rd(W, 96, 16) >> 8, rd(W, 112, 16) >> 8];
      for (let i = 0; i < texels; i++) out.set(c, i * 4);
      return true;
    }
    const bm = blockMode(m);
    if (!bm) return false;
    const [xw, yw, dual, wlv] = bm;
    const parts = rd(W, 11, 2) + 1, planes = dual ? 2 : 1, nw = xw * yw * planes;
    if ((dual && parts === 4) || nw > 64 || xw > bw || yw > bh) return false;
    const wbits = iseBits(nw, wlv);
    if (wbits < 24 || wbits > 96) return false;
    const rv = maskTo(Uint32Array.of(rev32(W[3]), rev32(W[2]), rev32(W[1]), rev32(W[0])), wbits);
    ise(rv, nw, wlv, RD, RM);
    for (let i = 0; i < nw; i++) WTS[i] = unqWeight(RD[i], RM[i], wlv);
    let below = 128 - wbits, ccs = 0;
    if (dual) { below -= 2; ccs = rd(W, below, 2); }
    const cems = [0, 0, 0, 0];
    let start;
    if (parts === 1) { cems[0] = rd(W, 13, 4); start = 17; }
    else {
      start = 29;
      let enc = rd(W, 23, 6);
      const base = enc & 3;
      if (base === 0) cems.fill((enc >> 2) & 0xf, 0, parts);
      else {
        const extra = 3 * parts - 4;
        if (below < extra) return false;
        below -= extra;
        enc |= rd(W, below, extra) << 6;
        for (let i = 0; i < parts; i++) {
          const cs = (enc >> (2 + i)) & 1, mm = (enc >> (2 + parts + 2 * i)) & 3;
          cems[i] = ((base - 1 + cs) << 2) | mm;
        }
      }
    }
    let nvals = 0;
    for (let i = 0; i < parts; i++) nvals += 2 * ((cems[i] >> 2) + 1);
    if (nvals > 18 || below < start) return false;
    const avail = below - start;
    const clv = COLOR_LEVELS.find((lv) => iseBits(nvals, lv) <= avail);
    if (clv === undefined) return false;
    ise(maskTo(shr(W, start), iseBits(nvals, clv)), nvals, clv, CD, CM);
    for (let i = 0; i < nvals; i++) CV[i] = unqColor(CD[i], CM[i], clv);
    const eps = [];
    let pos = 0;
    for (let i = 0; i < parts; i++) {
      const n = 2 * ((cems[i] >> 2) + 1);
      const e = endpoints(cems[i], CV.subarray(pos, pos + n));
      if (!e) return false;
      eps.push(e); pos += n;
    }
    infill(WTS, 0, planes, xw, yw, bw, bh, W0);
    if (dual) infill(WTS, 1, planes, xw, yw, bw, bh, W1);
    const seed = rd(W, 13, 10);
    for (let i = 0; i < texels; i++) {
      const p = parts > 1 ? partition(seed, i % bw, (i / bw) | 0, parts, texels < 31) : 0;
      const [e0, e1] = eps[p];
      for (let c = 0; c < 4; c++) {
        const w = dual && c === ccs ? W1[i] : W0[i];
        const a = srgb && c < 3 ? (e0[c] << 8) | 0x80 : e0[c] * 257, b = srgb && c < 3 ? (e1[c] << 8) | 0x80 : e1[c] * 257;
        out[i * 4 + c] = ((a * (64 - w) + b * w + 32) >> 6) >> 8;
      }
    }
    return true;
  }

  // A .bntx.zs file → [{ name, w, h, rgba }]
  function readTextures(zs) {
    const b = decompress(zs instanceof Uint8Array ? zs : new Uint8Array(zs));
    return bntx(b).map((t) => ({ name: t.name, ...surface(b, t) }));
  }
  return { decompress, bntx, surface, astcBlock, readTextures };
})();
if (typeof module !== "undefined") module.exports = TexDec;
