// Dump an application form's structure (labels -> controls) to design config selectors. Read-only; no extension.
import { chromium } from "playwright-core"; import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const url = process.argv[2]; const open = process.argv[3]; // optional CSS of a combobox to open and dump options
const findChrome = () => { const pw = path.join(os.homedir(), ".cache", "ms-playwright"); for (const d of fs.readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const p = path.join(pw, d, "chrome-linux64/chrome"); if (fs.existsSync(p)) return p; } };
const b = await chromium.launch({ headless: true, executablePath: findChrome() }); const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
await p.goto(url, { waitUntil: "load" }); await p.waitForTimeout(2500);
const rows = await p.evaluate(() => {
  const txt = (e) => (e?.innerText || e?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70);
  const out = [];
  for (const el of document.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox], button[aria-haspopup]")) {
    let label = ""; if (el.id) label = txt(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (!label && el.getAttribute("aria-labelledby")) label = el.getAttribute("aria-labelledby").split(" ").map((i) => txt(document.getElementById(i))).join(" | ");
    if (!label) label = el.getAttribute("aria-label") || "";
    if (!label) { const box = el.closest(".field, [class*='field'], fieldset, div"); label = txt(box?.querySelector("label, legend")); }
    const react = Object.keys(el).some((k) => k.startsWith("__react"));
    out.push({ tag: el.tagName.toLowerCase(), type: el.type || "", id: el.id, name: el.name || "", cls: (el.className || "").toString().slice(0, 60), role: el.getAttribute("role") || "", label, react, parentCls: (el.parentElement?.className || "").toString().slice(0, 50) });
  }
  return out;
});
for (const r of rows) console.log(`${r.tag.padEnd(8)} ${r.type.padEnd(8)} id=${r.id.padEnd(28)} name=${r.name.slice(0, 40).padEnd(40)} role=${r.role.padEnd(9)} react=${r.react} cls=${r.cls.padEnd(30)} | ${r.label}`);
if (open) {
  await p.click(open); await p.waitForTimeout(600);
  const opts = await p.evaluate(() => Array.from(document.querySelectorAll("[role=option], [class*='option']")).filter((o) => o.offsetParent !== null).slice(0, 12).map((o) => ({ cls: o.className.toString().slice(0, 60), role: o.getAttribute("role"), text: (o.innerText || "").trim().slice(0, 50), id: o.id })));
  console.log("\nopened", open, "options:", opts);
  const menu = await p.evaluate(() => { const m = document.querySelector("[class*='menu'], [role=listbox]"); return m ? { cls: m.className.toString().slice(0, 80), role: m.getAttribute("role"), parent: m.parentElement?.tagName } : null; }); console.log("menu:", menu);
}
await b.close();
