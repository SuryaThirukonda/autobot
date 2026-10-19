// Autobot engine: label extraction and deterministic field classification (generic fallback).
var AB = globalThis.AB || (globalThis.AB = {});

// Ordered rules: first match wins. Each rule: [profileKeyPath, [must-contain any], [must-not-contain any]]
// Labels are normalized with AB.norm before matching.
AB.RULES = [
  ["first_name", ["first name", "given name", "forename", "firstname"], ["last", "preferred"]],
  ["last_name", ["last name", "surname", "family name", "lastname"], ["first", "preferred"]],
  ["preferred_name", ["preferred name", "preferred first", "nickname", "name you go by"], []],
  ["full_name", ["full name", "legal name", "your name", "candidate name", "name"], ["company", "school", "user", "first", "last", "preferred", "file", "contact", "referr", "emergency", "manager", "pronounce", "pronunciation", "call you", "nickname", "middle", "maiden"]],
  ["pronouns", ["pronoun"], []],
  ["email", ["email", "e mail"], ["confirm", "verify", "re enter", "manager", "referr", "recruiter"]],
  ["email", ["confirm email", "verify email", "re enter email", "email confirmation"], []],
  ["work_auth_us", ["legally authorized", "authorized to work", "eligible to work", "work authorization", "right to work", "authorised to work", "legally eligible", "authorized to work lawfully"], []],
  ["sponsorship", ["sponsorship", "sponsor", "visa"], []],
  ["over18", ["18 years", "over 18", "at least 18", "age of 18"], []],
  ["phone_country", ["country code", "phone country", "dial code"], []],
  ["phone", ["phone", "mobile", "cell", "telephone", "contact number"], ["country", "code", "type", "extension", "ext"]],
  ["linkedin", ["linkedin"], []],
  ["github", ["github"], []],
  ["portfolio", ["portfolio", "personal site", "personal website"], []],
  ["twitter", ["twitter", "x profile"], []],
  ["website", ["website", "url", "web site", "homepage", "other link"], ["linkedin", "github", "company", "portfolio"]],
  ["address", ["street", "address line 1", "address 1", "mailing address", "home address", "address"], ["email", "2", "city", "state", "zip", "country", "ip"]],
  ["address_2", ["address line 2", "address 2", "apartment", "apt", "suite", "unit"], []],
  ["postal_code", ["zip", "postal", "postcode"], []],
  ["city", ["city", "town", "locality"], ["state", "country"]],
  ["state", ["state", "province", "region"], ["country", "united"]],
  ["country", ["country", "nation"], ["code", "phone"]],
  ["location", ["location", "where are you located", "where are you currently located", "currently located", "where do you live", "where do you currently live", "current location", "where are you based", "based"], ["work location", "preferred", "office", "job", "relocat"]],
  ["current_company", ["current company", "current employer", "employer", "company you work", "organization", "org"], ["previous", "school"]],
  ["current_title", ["current title", "job title", "current role", "current position", "title"], ["degree", "mr", "ms", "salutation"]],
  ["years_experience", ["years of experience", "years experience", "how many years"], []],
  ["gender", ["gender", "sex"], ["identity", "transgender"]],
  ["hispanic", ["hispanic", "latino", "latinx"], []],
  ["ethnicity", ["race", "ethnicity", "ethnic"], []],
  ["veteran", ["veteran", "military", "armed forces"], []],
  ["disability", ["disability", "disabilities", "disabled"], []],
  ["salary", ["salary", "compensation", "pay expectation", "desired pay", "expected pay"], []],
  ["start_date", ["start date", "available to start", "availability", "when can you start", "earliest"], ["employment", "education", "experience"]],
  ["notice_period", ["notice period", "notice"], []],
  ["how_heard", ["how did you hear", "how you heard", "heard about this", "heard about us", "how did you find", "how did you learn", "source", "where did you hear", "referral source"], ["referred by", "name"]],
  ["referred_by", ["referred by", "referrer", "referral name", "who referred"], []],
  ["most_recent_school", ["school", "university", "college", "institution", "alma mater"], ["high school", "degree", "major"]],
  ["most_recent_degree", ["degree", "education level", "highest level of education", "qualification"], ["major", "discipline"]],
  ["most_recent_major", ["major", "field of study", "discipline", "concentration"], []],
  ["most_recent_gpa", ["gpa", "grade point"], []],
  ["skills_text", ["skills", "technologies", "tech stack"], []],
  ["cover_letter_text", ["cover letter", "covering letter", "letter of interest"], ["upload", "attach", "file"]],
];

// Question text for a radio/checkbox GROUP (legend, group aria-label, or the nearest preceding label/heading
// outside the option's own <label>).
AB.groupLabelFor = (el) => {
  const texts = [];
  const push = (t) => { const n = AB.norm(t); if (n && !texts.includes(n)) texts.push(n); };
  const own = el.closest("label");
  const fs = el.closest("fieldset");
  if (fs) { const lg = fs.querySelector("legend"); if (lg) push(lg.textContent); if (fs.getAttribute("aria-label")) push(fs.getAttribute("aria-label")); }
  const grp = el.closest("[role=radiogroup], [role=group]");
  if (grp) { if (grp.getAttribute("aria-label")) push(grp.getAttribute("aria-label")); const lb = grp.getAttribute("aria-labelledby"); if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) push(n.textContent); }); }
  // Walk up a few containers looking for a label/heading that is not the option's own label.
  let box = (own || el).parentElement;
  for (let depth = 0; box && depth < 5 && !texts.length; depth++, box = box.parentElement) {
    const cands = box.querySelectorAll("legend, label, h2, h3, h4, h5, p, span, div, [class*='label'], [class*='question'], [class*='title']");
    for (const c of cands) {
      if (c === own || (own && own.contains(c)) || c.contains(el)) continue;
      if (c.querySelector("input, select, textarea")) continue; // skip wrappers of other controls
      const t = (c.innerText || c.textContent || "").trim();
      if (t && t.length <= 200 && c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) { push(t); break; }
    }
  }
  return texts;
};

// Collect label text candidates for a control, most specific first.
AB.labelFor = (el, { group = true } = {}) => {
  const texts = [];
  const push = (t) => { const n = AB.norm(t); if (n && !texts.includes(n)) texts.push(n); };
  const root = el.getRootNode();
  const isChoice = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox");
  if (isChoice && group) AB.groupLabelFor(el).forEach(push);
  if (el.id) {
    try { root.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => push(l.textContent)); } catch {}
  }
  const lb = el.getAttribute("aria-labelledby");
  if (lb) lb.split(/\s+/).forEach((id) => { const n = root.getElementById ? root.getElementById(id) : document.getElementById(id); if (n) push(n.textContent); });
  if (el.getAttribute("aria-label")) push(el.getAttribute("aria-label"));
  if (el.labels && el.labels.length) Array.from(el.labels).forEach((l) => push(l.textContent));
  const wrap = el.closest("label");
  if (wrap) push(wrap.textContent);
  // fieldset legend / nearest preceding heading or label within a field container
  const box = el.closest('fieldset, .field, .form-group, .form-field, [class*="field"], [class*="question"], [class*="form-item"], [class*="input-wrapper"], li, tr, div');
  if (box) {
    const lg = box.querySelector("legend, label, h2, h3, h4, [class*='label'], [class*='question-text'], [class*='title']");
    if (lg && !lg.contains(el)) push(lg.textContent);
  }
  // Question text held by a sibling of the control's wrapper (e.g. Lever: <div class="application-label">…</div><div class="application-field"><textarea>)
  if (!isChoice) AB.groupLabelFor(el).forEach(push);
  // preceding sibling text (for bare inputs)
  let p = el.previousElementSibling;
  for (let i = 0; p && i < 2; i++, p = p.previousElementSibling) if (/^(LABEL|SPAN|P|DIV|STRONG|B)$/.test(p.tagName) && p.textContent.trim().length < 160) push(p.textContent);
  if (el.placeholder) push(el.placeholder);
  if (el.name) push(el.name.replace(/[\[\]_\-.]/g, " "));
  if (el.id) push(el.id.replace(/[\[\]_\-.]/g, " "));
  if (el.getAttribute("data-automation-id")) push(el.getAttribute("data-automation-id").replace(/[\-_]/g, " "));
  if (el.autocomplete && el.autocomplete !== "off") push(el.autocomplete.replace(/-/g, " "));
  return texts;
};

// autocomplete attribute shortcut (deterministic and standard).
AB.AUTOCOMPLETE_MAP = {
  "given-name": "first_name", "family-name": "last_name", "name": "full_name", "email": "email", "tel": "phone",
  "tel-national": "phone", "street-address": "address", "address-line1": "address", "address-line2": "address_2",
  "address-level2": "city", "address-level1": "state", "postal-code": "postal_code", "country": "country",
  "country-name": "country", "organization": "current_company", "organization-title": "current_title", "url": "website",
};

// Keyword test with word boundaries so "unit" does not match "united" and "org" does not match "organization".
AB._kwCache = new Map();
AB.hasKw = (label, kw) => {
  let re = AB._kwCache.get(kw);
  if (!re) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    re = new RegExp("(^|\\s)" + esc + "(?=\\s|$)", "i");
    AB._kwCache.set(kw, re);
  }
  return re.test(label);
};

AB.classify = (el) => {
  const ac = (el.getAttribute("autocomplete") || "").split(" ").pop();
  if (ac && AB.AUTOCOMPLETE_MAP[ac]) return { key: AB.AUTOCOMPLETE_MAP[ac], via: "autocomplete", label: ac };
  const type = (el.getAttribute("type") || el.tagName).toLowerCase();
  if (type === "email") return { key: "email", via: "type", label: "email" };
  if (type === "tel") return { key: "phone", via: "type", label: "phone" };
  const labels = AB.labelFor(el);
  // Search boxes inside widgets (intl-tel-input country list, typeahead filters) are never identity fields.
  // A type=search input that is itself a listbox combobox (aria-haspopup/role/aria-autocomplete) is a real field.
  const comboLike = el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("role") === "combobox" || el.hasAttribute("aria-autocomplete");
  const widgetInner = el.matches(".iti__search-input, .iti input, .select2-search__field, .chosen-search input, [class*='search-input'], [class*='searchInput']") || el.closest(".select2-dropdown, .chosen-drop, [role=listbox]") || (el.closest("[role=dialog]") && el.matches("[class*='search'], [role=searchbox]"));
  if (widgetInner || (type === "search" && !comboLike)) return { key: null, via: "search-box", label: AB.displayLabel(labels), labels: [] };
  // Open-ended questions are never profile fields; only a saved answer may fill them.
  const primary = AB.displayLabel(labels);
  if (AB.FREE_TEXT.test(primary) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement && /^(radio|checkbox|file)$/.test(el.type)))
    return { key: null, via: "free-text", label: primary, labels };
  for (const label of labels) {
    for (const [key, incl, excl] of AB.RULES) {
      if (incl.some((k) => AB.hasKw(label, k)) && !excl.some((k) => AB.hasKw(label, k))) return { key, via: "label", label, labels };
    }
  }
  return { key: null, via: null, label: AB.displayLabel(labels), labels };
};

AB.FREE_TEXT = /(^|\s)(how do you|how would you|why do you|why are you|why would you|what has been|what is your favorite|what are you|describe|tell us|explain|in what ways|anything else|additional information|comments?)(\s|$)/;

// Pick the most question-like label for display and saved-answer lookup: skip placeholders/markers, prefer the longest.
AB.GENERIC_LABELS = /^(type your response|start typing|pick date|select|search|choose|choose one|yes|no|✱|\*|required|optional|enter .*|your answer)$/;
AB.displayLabel = (labels) => {
  const good = labels.filter((l) => l && !AB.GENERIC_LABELS.test(l) && !/^[0-9a-f]{8}( [0-9a-f]{4}){3} [0-9a-f]{12}/.test(l) && !/^cards? [0-9a-f]{8}/.test(l));
  return (good.sort((a, b) => b.length - a.length)[0]) || labels[0] || "";
};

// A control taken out of the page's tab order and hidden from assistive tech is never a question a person answers:
// react-select's empty "required" input (opacity 0 under a required question until something is picked; its label
// would be the placeholder or the live region, "? select", "? 7 results available …"), or a honeypot. Checkboxes,
// radios, file inputs and selects stay: widgets drive those from a visible button, and some read changes on them.
AB.isHiddenFromPeople = (el) =>
  el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1" &&
  !(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement && /^(checkbox|radio|file)$/.test(el.type));

// Enumerate fillable controls under a container, deduplicating radio groups and hidden widgets.
AB.enumerateControls = (container) => {
  const sel = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [role=combobox], [role=textbox], [contenteditable=true]';
  const nodes = Array.from((container || document).querySelectorAll(sel));
  // include open shadow roots one level deep
  (container || document).querySelectorAll("*").forEach((h) => { if (h.shadowRoot) nodes.push(...h.shadowRoot.querySelectorAll(sel)); });
  const seen = new Set();
  const out = [];
  for (const el of nodes) {
    if (el.disabled || el.readOnly) continue;
    if (el.closest("[data-autobot-panel]")) continue;
    if (!AB.isVisible(el) && el.type !== "file" && el.type !== "radio" && el.type !== "checkbox") continue;
    if (AB.isHiddenFromPeople(el)) continue;
    const key = el.type === "radio" && el.name ? `radio:${el.name}` : el;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
};
