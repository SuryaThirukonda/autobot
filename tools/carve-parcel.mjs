// Split a prettified Parcel bundle into one CommonJS file per app module.
// usage: node carve-parcel.mjs <pretty-bundle.js> <out-dir> <bundle-label>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [src, out, label] = process.argv.slice(2);
const L = fs.readFileSync(src, 'utf8').split('\n');
const START = /^        ("([^"]+)"|([A-Za-z0-9_$]+)): \[$/;
const starts = [];
L.forEach((l, i) => { const m = START.exec(l); if (m) starts.push({ i, id: m[2] || m[3] }); });
const mods = new Map();
for (let k = 0; k < starts.length; k++) {
  const { i, id } = starts[k];
  const stop = k + 1 < starts.length ? starts[k + 1].i : L.length;
  const hdr = L[i + 1] || '';
  const hm = /^          function \(([^)]*)\) \{$/.exec(hdr);
  if (!hm) continue;
  let fnEnd = -1;
  for (let j = stop - 1; j > i + 1; j--) {
    if (L[j] === '          },' && /^          \{/.test(L[j + 1] || '')) { fnEnd = j; break; }
  }
  if (fnEnd < 0) continue;
  const deps = {};
  for (let j = fnEnd + 1; j < stop; j++) {
    const dm = /^            (?:"([^"]+)"|([A-Za-z0-9_$]+)): "([^"]+)",?$/.exec(L[j]);
    if (dm) deps[dm[1] || dm[2]] = dm[3];
    if (L[j] === '        ],') break;
  }
  mods.set(id, { id, params: hm[1].split(',').map(s => s.trim()).filter(Boolean), bodyStart: i + 2, bodyEnd: fnEnd - 1, deps, names: new Set() });
}
// name resolution: ~aliases are absolute; relative deps resolve from the importer's directory,
// where a ~module is treated as a directory index when its known relative targets agree.
const canon = new Map();
const tilde = new Map();
for (const m of mods.values()) for (const [n, d] of Object.entries(m.deps)) {
  if (n.startsWith('~')) { if (!tilde.has(d)) tilde.set(d, n.replace(/^~\/?/, '')); }
  else if (!n.startsWith('.') && !canon.has(d)) canon.set(d, 'node_modules/' + n);
}
for (const [d, n] of tilde) canon.set(d, n);
const allTilde = new Set(tilde.values());
const isIndex = new Map();
const decideIndex = (m, base) => {
  let fileVotes = 0, indexVotes = 0;
  for (const [n, d] of Object.entries(m.deps)) {
    if (!n.startsWith('.') || !tilde.has(d)) continue;
    const known = tilde.get(d).replace(/\.(ts|tsx|js)$/, '');
    if (pp.normalize(pp.join(pp.dirname(base), n)) === known) fileVotes++;
    if (pp.normalize(pp.join(base, n)) === known) indexVotes++;
  }
  if (indexVotes !== fileVotes) return indexVotes > fileVotes;
  if ([...allTilde].some(t => t.startsWith(base + '/'))) return true;
  return Object.keys(m.deps).some(n => n.startsWith('../'));
};
const pp = path.posix;
const relFrom = new Map(); // id -> importer id that named it relatively
const resolveRelative = () => {
  for (const id of [...canon.keys()]) if (relFrom.has(id)) canon.delete(id);
  relFrom.clear();
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    for (const m of mods.values()) {
      const base = canon.get(m.id); if (!base || base.startsWith('node_modules/')) continue;
      if (!isIndex.has(m.id)) isIndex.set(m.id, decideIndex(m, base));
      const dir = isIndex.get(m.id) ? base : pp.dirname(base);
      for (const [n, d] of Object.entries(m.deps)) {
        if (!n.startsWith('.') || canon.has(d)) continue;
        canon.set(d, pp.normalize(pp.join(dir, n))); relFrom.set(d, m.id); changed = true;
      }
    }
    if (!changed) break;
  }
};
for (let round = 0; round < 10; round++) {
  resolveRelative();
  const owners = new Map();
  for (const [id, n] of canon) { if (!owners.has(n)) owners.set(n, []); owners.get(n).push(id); }
  let flipped = 0;
  for (const ids of owners.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const imp = relFrom.get(id); if (!imp || isIndex.get(imp)) continue;
      const nRel = Object.keys(mods.get(imp).deps).filter(n => n.startsWith('./')).length;
      if (nRel >= 3) { isIndex.set(imp, true); flipped++; }
    }
  }
  if (!flipped) break;
}
const isApp = id => { const c = canon.get(id); if (c) return !c.startsWith('node_modules/') && !c.includes('/node_modules/'); const m = mods.get(id); return Object.keys(m.deps).some(n => n.startsWith('~')); };
const fileSeen = new Map();
const fileOf0 = id => {
  let c = canon.get(id) || `_unnamed/${id}`;
  if (isIndex.get(id)) c = c + '/index';
  c = c.replace(/^\.\.\//, '_up/').replace(/[^A-Za-z0-9_./@-]/g, '_');
  if (!/\.(js|json)$/.test(c)) c += '.js'; else if (c.endsWith('.json')) c += '.js';
  return c;
};
const fileMemo = new Map();
const fileOf = id => {
  if (fileMemo.has(id)) return fileMemo.get(id);
  let f = fileOf0(id);
  if (fileSeen.has(f) && fileSeen.get(f) !== id) f = f.replace(/\.js$/, `.${id}.js`);
  fileSeen.set(f, id); fileMemo.set(id, f); return f;
};
for (const m of mods.values()) if (isApp(m.id)) fileOf(m.id);
fs.mkdirSync(out, { recursive: true });
const index = [];
for (const m of mods.values()) {
  if (!isApp(m.id)) continue;
  const f = fileOf(m.id);
  const [req = '__req', mod = '__mod', exp = '__exp', ...rest] = m.params;
  let body = L.slice(m.bodyStart, m.bodyEnd + 1).join('\n');
  for (const [n, d] of Object.entries(m.deps)) {
    const target = mods.has(d) && isApp(d) ? './' + path.posix.relative(path.posix.dirname(f), fileOf(d)) : n;
    const rel = target.startsWith('./../') ? target.slice(2) : target;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp(`\\b${req}\\(\\s*"${esc}"\\s*\\)`, 'g'), `require(${JSON.stringify(rel)})`);
  }
  const head = [
    `// Carved from ${label} (Parcel module ${m.id}); prettified lines ${m.bodyStart + 1}-${m.bodyEnd + 1}.`,
    `// Source name: ${canon.get(m.id) ? '~' + canon.get(m.id) : '(unnamed)'}`,
    `var ${req} = require, ${mod} = module, ${exp} = exports${rest.map(p => `, ${p}`).join('')};`,
  ].join('\n');
  const text = head + '\n' + body + '\n';
  const fp = path.join(out, f);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text);
  index.push({ file: f, parcel_id: m.id, source_name: canon.get(m.id) || null, pretty_lines: [m.bodyStart + 1, m.bodyEnd + 1], bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), deps: m.deps });
}
fs.writeFileSync(path.join(out, 'carve-index.json'), JSON.stringify({ bundle: label, pretty_source: src, modules: index.sort((a, b) => a.file.localeCompare(b.file)) }, null, 1));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'jobright-helper-app-carved', private: true, main: 'index.js' }, null, 1));
console.log(`modules parsed=${mods.size} named=${canon.size} app-emitted=${index.length} bytes=${index.reduce((s, x) => s + x.bytes, 0)}`);
