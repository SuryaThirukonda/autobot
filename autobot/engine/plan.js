// Autobot engine: plan execution. Config fields -> steps -> writes. Plus heuristic pass for unmatched controls.
var AB = globalThis.AB || (globalThis.AB = {});

// Value maps shared by configs (name -> { profileValue: optionLabel | [labels] })
AB.VALUE_MAPS = {
  yesNo: { true: ["Yes", "Y", "True"], false: ["No", "N", "False"], yes: ["Yes"], no: ["No"] },
  workAuth: { true: ["Yes", "I am authorized", "Authorized"], false: ["No", "Not authorized"] },
  sponsorship: { true: ["Yes", "Will require sponsorship"], false: ["No", "Do not require sponsorship", "No, I will not"] },
  gender: { "Decline to self-identify": ["Decline To Self Identify", "Prefer not to say", "I don't wish to answer", "Decline to self identify", "I prefer not to answer"], Male: ["Man"], Female: ["Woman"] },
  ethnicity: { "Decline to self-identify": ["Decline To Self Identify", "Prefer not to say", "I don't wish to answer", "Decline to self identify"], White: ["White (Not Hispanic or Latino)", "Caucasian"], Asian: ["Asian (Not Hispanic or Latino)"], "Black or African American": ["Black"], "Hispanic or Latino": ["Hispanic/Latino", "Hispanic/Latinx"], "Two or More Races": ["Two or more races", "Multiracial"] },
  hispanic: { "Decline to self-identify": ["Decline To Self Identify", "Prefer not to say", "I don't wish to answer"], yes: ["Yes"], no: ["No"], true: ["Yes"], false: ["No"] },
  veteran: { "I am not a protected veteran": ["I am not a protected veteran", "No", "I am not a veteran", "Not a Protected Veteran"], "I identify as one or more of the classifications of a protected veteran": ["I identify as one or more of the classifications of a protected veteran", "Yes", "Protected Veteran"], "I don't wish to answer": ["I don't wish to answer", "Decline to self identify", "Prefer not to say"] },
  disability: { "I do not want to answer": ["I do not want to answer", "I don't wish to answer", "Decline to self identify", "Prefer not to say"], "Yes, I have a disability, or have had one in the past": ["Yes", "Yes, I have a disability (or previously had a disability)"], "No, I do not have a disability and have not had one in the past": ["No", "No, I don't have a disability"] },
  degree: { "Bachelor's": ["Bachelor's Degree", "Bachelors", "Bachelor of Science (BS)", "Bachelor of Arts (BA)", "BS", "BA", "B.S.", "Bachelor"], "Master's": ["Master's Degree", "Masters", "MS", "MA", "M.S.", "Master"], "PhD": ["Doctor of Philosophy (Ph.D.)", "Doctorate", "Ph.D.", "Doctoral"], "High School": ["High School Diploma", "High School or equivalent"], "Associate's": ["Associate's Degree", "Associates", "AA", "AS"], "MBA": ["Master of Business Administration (M.B.A.)"] },
  month: Object.fromEntries(["January","February","March","April","May","June","July","August","September","October","November","December"].map((m, i) => [String(i + 1), [m, m.slice(0, 3), String(i + 1).padStart(2, "0"), String(i + 1)]])),
};

AB.mapValue = (value, values) => {
  if (!values) return AB.arr(value);
  const map = typeof values === "string" ? AB.VALUE_MAPS[values] : values;
  if (!map) return AB.arr(value);
  const out = [];
  for (const v of AB.arr(value)) {
    const k = String(v);
    const alts = map[k] ?? map[k.toLowerCase()] ?? map[AB.norm(k)];
    if (alts) out.push(...AB.arr(alts));
    out.push(v);
  }
  return Array.from(new Set(out.map(String)));
};

// Build the synonyms dictionary for AB.bestOption from a value map.
AB.synonymsFrom = (values) => {
  const map = typeof values === "string" ? AB.VALUE_MAPS[values] : values;
  if (!map) return undefined;
  const syn = {};
  for (const [k, alts] of Object.entries(map)) syn[AB.norm(k)] = AB.arr(alts);
  return syn;
};

// Execute one field (or nested array section). Reports via onStatus(key, status, detail).
AB.runField = async (field, state, keyPrefix = "", data = state.profile) => {
  const { container, profile, resume, signal, onStatus } = state;
  const key = field.key;
  const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;
  if (signal?.aborted) return false;

  // Nested array sections (education[], experience[]).
  if (field.array) {
    const items = AB.arr(data?.[key]);
    const limit = Math.min(field.limit || items.length, items.length);
    if (!limit) { onStatus(fullKey, "skipped", "no entries"); return false; }
    let wroteAny = false;
    for (let i = 0; i < limit; i++) {
      if (i > 0 && field.add) {
        const btn = AB.queryAny(field.add, container);
        if (btn) { AB.fire(btn, ["mousedown", "mouseup", "click"]); await AB.sleep(field.addDelay || 400); }
      }
      // Section container: Nth match of field.item path, else whole container.
      let sectionCtx = container;
      if (field.item) {
        const secs = AB.queryAny(field.item, container, true);
        sectionCtx = secs[i] || secs[secs.length - 1] || container;
      }
      for (const sub of field.fields || []) {
        if (await AB.runField(sub, { ...state, container: sectionCtx }, `${fullKey}[${i}]`, items[i])) wroteAny = true;
      }
    }
    return wroteAny;
  }

  // Resolve the value.
  let value = field.value;
  if (value === undefined) {
    const vk = field.valueKey || key;
    value = keyPrefix ? AB.getProfileValue({ ...profile, ...data, _item: data }, vk) ?? AB.getProfileValue(data, vk) : AB.getProfileValue(profile, vk);
    if (value === undefined && field.answerLabel) value = AB.lookupAnswer(profile, field.answerLabel);
  }
  const needsValue = field.required !== false && !field.hidden && field.method !== "click" && field.method !== "upload";
  if (needsValue && (value === undefined || value === "")) { onStatus(fullKey, "skipped", "no profile value"); return true; }
  if (field.method === "upload" && !resume?.dataBase64) { onStatus(fullKey, "skipped", "no resume stored"); return true; }

  const candidates = AB.mapValue(value, field.values);
  const synonyms = AB.synonymsFrom(field.values);
  const steps = field.actions?.length ? field.actions : [{ path: field.path, method: field.method, time: field.time, allowFailure: field.allowFailure, condition: field.condition, event: field.event }];
  let anyWrite = false, lastEl = null, anyFound = false;

  for (const step of steps) {
    if (signal?.aborted) return false;
    if (step.condition && !AB.xpathBool(AB.template(step.condition, candidates[0]), container)) continue;
    if (step.delay) { await AB.sleep(step.delay); continue; }
    const method = step.method || field.method || state.config.defaultMethod || "default";
    let el = null, usedValue = candidates[0];
    const paths = AB.arr(step.path ?? field.path);
    if (paths.length) {
      // Paths containing %VALUE% are tried per candidate value (e.g. option labels).
      if (AB.hasValueTemplate(paths)) {
        for (const v of candidates) {
          el = await AB.waitFor(paths.map((p) => AB.template(p, v)), { ctx: container, timeout: step.time ?? 1500, signal });
          if (el) { usedValue = v; break; }
        }
      } else {
        el = await AB.waitFor(paths, { ctx: container, timeout: step.time ?? (field.time ?? 2500), signal });
      }
      if (!el) {
        if (step.allowFailure || field.allowFailure) continue;
        onStatus(fullKey, anyWrite ? "filled" : "not-found", paths[0]);
        return anyWrite;
      }
      lastEl = el;
      anyFound = true;
      state.touched?.add(el);
    } else if (lastEl) el = lastEl;
    if (!el) continue;
    if (step.removed) { await AB.waitGone(el, step.time || 4000); continue; }
    if (!step.method && !field.method && !step.event && steps.length > 1 && step !== steps[steps.length - 1]) continue; // locate-only step
    if (step.event) { AB.fire(el, step.event, step.eventOptions); anyWrite = true; continue; }

    let ok = false;
    try {
      if (method === "upload") ok = AB.writeFile(el, resume);
      else if (method === "select" || method === "radio" || method === "checkbox" || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")))
        ok = await AB.write(el, method, el instanceof HTMLInputElement && el.type === "checkbox" ? value : candidates, { synonyms });
      else ok = await AB.write(el, method, usedValue, { synonyms, optionsPath: field.optionsPath, eventOptions: step.eventOptions });
    } catch (e) { AB.log("write error", fullKey, e); ok = false; }
    if (!ok && !(step.allowFailure || field.allowFailure)) { onStatus(fullKey, "error", `${method} failed`); return false; }
    anyWrite = anyWrite || ok;
    if (step.time && step.method === "click") await AB.sleep(Math.min(step.time, 1500));
    else await AB.sleep(state.config.fillInterval ?? 60);
  }
  if (!anyFound) { onStatus(fullKey, "absent", "no matching element on this page"); return false; }
  onStatus(fullKey, anyWrite ? "filled" : "skipped", anyWrite ? String(AB.readBack(AB.refresh(lastEl)) || candidates[0] || "").slice(0, 60) : "write failed or nothing to write");
  return anyWrite;
};

// Heuristic pass: classify every control not already touched and fill from the profile.
AB.runHeuristics = async (state, touched) => {
  const { container, profile, resume, onStatus, signal } = state;
  const controls = AB.enumerateControls(container);
  let n = 0;
  for (let el of controls) {
    if (signal?.aborted) return n;
    if (touched.has(el)) continue;
    if (el instanceof HTMLInputElement && el.type === "file") {
      const lbl = AB.labelFor(el).join(" ");
      if (/resume|cv|curriculum/.test(lbl) && resume?.dataBase64 && !el.files?.length) { if (AB.writeFile(el, resume)) { onStatus("resume", "filled", resume.name); n++; } }
      continue;
    }
    const current = AB.readBack(el);
    if (current && !(el instanceof HTMLSelectElement && el.selectedIndex <= 0 && /select|choose|--/.test(AB.norm(current)))) continue; // already has a value
    const { key, label, labels } = AB.classify(el);
    const answerFor = () => { for (const l of labels || [label]) { const a = AB.lookupAnswer(profile, l); if (a !== undefined) return a; } return undefined; };
    const isCheckbox = el instanceof HTMLInputElement && el.type === "checkbox";
    if (isCheckbox) {
      // Never tick consent/marketing/certification boxes, and only tick boxes whose question is a yes/no profile fact.
      if (/agree|consent|acknowledg|certif|marketing|newsletter|subscribe|terms|privacy|policy|confirm|accurate|signature/.test(label)) continue;
      if (!["work_auth_us", "sponsorship", "over18"].includes(key)) { const a = answerFor(); if (a === undefined) continue; const yes = /^(yes|true|y)$/i.test(String(a)); const ok = AB.setChecked(el, yes); touched.add(el); onStatus(`? ${label.slice(0, 40)}`, ok ? "filled" : "error", String(a)); if (ok) n++; continue; }
    }
    let value, values;
    if (key) {
      value = AB.getProfileValue(profile, key);
      values = { work_auth_us: "workAuth", sponsorship: "sponsorship", over18: "yesNo", gender: "gender", ethnicity: "ethnicity", hispanic: "hispanic", veteran: "veteran", disability: "disability", most_recent_degree: "degree" }[key];
      if (typeof value === "boolean") value = AB.boolToYesNo(value);
    } else {
      value = answerFor();
    }
    if (value === undefined || value === "") { if (label) onStatus(`? ${label.slice(0, 40)}`, "unknown", key ? `${key} (empty in profile)` : "no rule"); continue; }
    if (isCheckbox && !(/^(yes|true|y)$/i.test(String(AB.boolToYesNo(value))))) { onStatus(`? ${label.slice(0, 40)}`, "skipped", `left unchecked (${AB.boolToYesNo(value)})`); touched.add(el); continue; }
    const candidates = AB.mapValue(value, values);
    const synonyms = AB.synonymsFrom(values);
    let ok = false;
    try {
      el = AB.refresh(el);
      if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox"))) ok = await AB.write(el, "default", candidates, { synonyms });
      else ok = await AB.write(el, "default", candidates[0], { synonyms });
    } catch (e) { AB.log("heuristic write failed", e); }
    touched.add(el);
    onStatus(key || `? ${label.slice(0, 40)}`, ok ? "filled" : "error", ok ? String(candidates[0]).slice(0, 60) : "write failed");
    if (ok) n++;
    await AB.sleep(50);
  }
  return n;
};

// Top-level fill. Returns summary.
AB.fill = async ({ config, profile, resume, settings, onStatus = () => {}, signal } = {}) => {
  const container = AB.findContainer(config);
  const touched = new Set();
  const state = { config, container, profile, resume, settings, onStatus, signal, touched };
  const statusWrap = (k, s, d) => { onStatus(k, s, d); };
  state.onStatus = statusWrap;
  // Pre-steps (e.g. click "Apply" to reveal the form).
  for (const pre of config.pre || []) {
    const el = await AB.waitFor(pre.path, { ctx: document, timeout: pre.time || 1500 });
    if (el) { AB.fire(el, ["mousedown", "mouseup", "click"]); await AB.sleep(pre.delay || 800); }
  }
  let filled = 0;
  for (const field of config.fields || []) {
    const ok = await AB.runField(field, state);
    if (ok) filled++;
    // mark elements we touched so heuristics skip them
    AB.arr(field.path).forEach((p) => { if (!AB.hasValueTemplate(p)) AB.query(p, container, true).forEach((el) => touched.add(el)); });
  }
  if (config.heuristics !== false && settings?.heuristics !== false) filled += await AB.runHeuristics(state, touched);
  return { filled };
};

// Continuous mode: click continue/next until a submit button or success marker is visible (never clicks submit).
AB.advance = async (config) => {
  const btn = AB.queryAny(config.continue || [], AB.findContainer(config));
  if (!btn) return false;
  AB.fire(btn, ["mousedown", "mouseup", "click"]);
  await AB.sleep(1200);
  return true;
};
