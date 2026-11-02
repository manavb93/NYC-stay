/* StayWise NYC: frontend logic.
 * Talks to the FastAPI backend. No predictions are ever simulated:
 * if the backend is down or returns an error, the user sees an error. */

// ---------- Config ----------
const API_URL = "http://127.0.0.1:8000/predict";
const TIMEOUT_MS = 15000;

// Field names must match the Pydantic `Features` model exactly.
const INT_FIELDS = ["minimum_nights", "number_of_reviews", "calculated_host_listings_count", "availability_365"];
const FLOAT_FIELDS = ["latitude", "longitude", "price", "reviews_per_month"];
const TEXT_FIELDS = ["neighbourhood_group", "neighbourhood"];

// Client-side rules mirror the backend (backend still has the final say).
const RULES = {
  latitude: { min: -90, max: 90 },
  longitude: { min: -180, max: 180 },
  price: { gt: 0 },
  minimum_nights: { min: 1, max: 365 },
  number_of_reviews: { min: 0 },
  reviews_per_month: { min: 0 },
  calculated_host_listings_count: { min: 0 },
  availability_365: { min: 0, max: 365 },
};

// ---------- Result content ----------
const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor"/></svg>',
  door: '<svg viewBox="0 0 24 24"><path d="M6 3h10a1 1 0 0 1 1 1v17H5V4a1 1 0 0 1 1-1zm7 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" fill="currentColor"/></svg>',
  bunk: '<svg viewBox="0 0 24 24"><path d="M3 3h2v18H3zm16 0h2v18h-2zM5 6h14v4H5zm0 7h14v4H5z" fill="currentColor"/></svg>',
};
const ROOM_TYPES = {
  "Entire home/apt": { cls: "entire", icon: ICONS.home, desc: "Enjoy complete privacy with an entire apartment or home to yourself." },
  "Private room": { cls: "private", icon: ICONS.door, desc: "A private room within a shared property, ideal for comfortable and affordable stays." },
  "Shared room": { cls: "shared", icon: ICONS.bunk, desc: "An economical accommodation option where guests share their sleeping space." },
};

// ---------- DOM ----------
const form = document.getElementById("predictForm");
const submitBtn = document.getElementById("submitBtn");
const resultCard = document.getElementById("result");
const states = {
  idle: document.getElementById("stateIdle"),
  loading: document.getElementById("stateLoading"),
  success: document.getElementById("stateSuccess"),
  error: document.getElementById("stateError"),
};
let isSubmitting = false;

// ---------- UI helpers ----------
function showState(name) {
  Object.entries(states).forEach(([key, el]) => { el.hidden = key !== name; });
  resultCard.classList.toggle("is-success", name === "success");
}

function setLoading(on) {
  isSubmitting = on;
  submitBtn.disabled = on;
  submitBtn.classList.toggle("is-loading", on);
  submitBtn.querySelector(".btn__label").textContent = on ? "Predicting..." : "Predict Room Type";
}

function showError(title, message) {
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMsg").textContent = message;
  showState("error");
}

function setFieldError(name, message) {
  const field = form.elements[name].closest(".field");
  field.classList.toggle("invalid", Boolean(message));
  field.querySelector(".err").textContent = message || "";
}

function clearFieldErrors() {
  [...INT_FIELDS, ...FLOAT_FIELDS, ...TEXT_FIELDS].forEach((n) => setFieldError(n, ""));
}

// ---------- Validation and payload ----------
function buildPayload() {
  const payload = {};
  const errors = {};

  for (const name of [...FLOAT_FIELDS, ...INT_FIELDS]) {
    const raw = form.elements[name].value.trim();
    const isInt = INT_FIELDS.includes(name);
    const value = Number(raw);
    const rule = RULES[name];

    if (raw === "" || Number.isNaN(value)) { errors[name] = "Enter a number."; continue; }
    if (isInt && !Number.isInteger(value)) { errors[name] = "Enter a whole number."; continue; }
    if (rule.gt !== undefined && value <= rule.gt) { errors[name] = `Must be greater than ${rule.gt}.`; continue; }
    if (rule.min !== undefined && value < rule.min) { errors[name] = `Must be at least ${rule.min}.`; continue; }
    if (rule.max !== undefined && value > rule.max) { errors[name] = `Must be at most ${rule.max}.`; continue; }
    payload[name] = value;
  }

  for (const name of TEXT_FIELDS) {
    const value = form.elements[name].value.trim();
    if (!value) { errors[name] = name === "neighbourhood_group" ? "Choose a borough." : "Enter a neighbourhood."; continue; }
    payload[name] = value;
  }
  return { payload, errors };
}

// FastAPI 422 responses carry detail: [{loc: [...], msg: "..."}]
function parseValidationErrors(detail) {
  if (!Array.isArray(detail)) return null;
  const lines = [];
  detail.forEach((d) => {
    const field = d.loc ? d.loc[d.loc.length - 1] : "input";
    lines.push(`${field}: ${d.msg}`);
    if (form.elements[field]) setFieldError(field, d.msg);
  });
  return lines.join(" | ");
}

// ---------- Submit ----------
async function handleSubmit(event) {
  event.preventDefault();
  if (isSubmitting) return; // block double submits

  clearFieldErrors();
  const { payload, errors } = buildPayload();
  if (Object.keys(errors).length) {
    Object.entries(errors).forEach(([n, m]) => setFieldError(n, m));
    form.querySelector(".invalid input, .invalid select")?.focus();
    return;
  }

  setLoading(true);
  showState("loading");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON body */ }

    if (!response.ok) {
      if (response.status === 422) {
        const msg = parseValidationErrors(data && data.detail);
        return showError("Check your inputs", msg || "The server rejected some values.");
      }
      const detail = data && typeof data.detail === "string" ? data.detail : `Server returned status ${response.status}.`;
      return showError("The server could not predict", detail);
    }

    // Accept the spec'd key and the key currently returned by the backend.
    const label = data && (data.room_type ?? data.Predicted_room_type ?? data.predicted_room_type);
    if (typeof label !== "string") {
      return showError("Unexpected response", "The server replied without a room type. Check the API response format.");
    }
    renderSuccess(label);
  } catch (err) {
    if (err.name === "AbortError") {
      showError("Request timed out", "The server took too long to respond. Try again.");
    } else {
      showError("Cannot reach the server", "Make sure FastAPI is running at http://127.0.0.1:8000 and that CORS allows this page's origin.");
    }
  } finally {
    clearTimeout(timer);
    setLoading(false);
  }
}

function renderSuccess(label) {
  const info = ROOM_TYPES[label] || { cls: "unknown", icon: ICONS.home, desc: "The model returned a room type this page does not recognise." };
  const wrap = document.getElementById("resultIconWrap");
  wrap.className = "result__iconwrap";
  wrap.innerHTML = info.icon;
  resultCard.classList.remove("result--entire", "result--private", "result--shared", "result--unknown");
  resultCard.classList.add(`result--${info.cls}`);

  const badge = document.getElementById("resultBadge");
  badge.className = `badge badge--${info.cls}`;
  badge.textContent = "Predicted room type";
  document.getElementById("resultTitle").textContent = label;
  document.getElementById("resultDesc").textContent = info.desc;
  showState("success");
  if (window.matchMedia("(max-width: 900px)").matches) resultCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- Navigation ----------
const navToggle = document.getElementById("navToggle");
const navLinks = document.getElementById("navLinks");
navToggle.addEventListener("click", () => {
  const open = navLinks.classList.toggle("open");
  navToggle.setAttribute("aria-expanded", String(open));
});
navLinks.addEventListener("click", (e) => {
  if (e.target.tagName === "A") { navLinks.classList.remove("open"); navToggle.setAttribute("aria-expanded", "false"); }
});

form.addEventListener("submit", handleSubmit);
document.getElementById("year").textContent = new Date().getFullYear();
