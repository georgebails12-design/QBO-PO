// Read-only "is it in QuickBooks?" page for people with the form link.
// /lookup?key=...&vendor=...&item=...&project=... checks those values on load.

function lookupUrl(path, params) {
  const qs = new URLSearchParams(Object.assign({ key: FORM_KEY }, params));
  return fetch(`${path}?${qs}`).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  });
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showResult(kind, r) {
  const el = document.getElementById(`lk-${kind}-result`);
  if (!r) { el.innerHTML = ''; el.className = 'lk-result'; return; }
  if (r.found) {
    el.className = 'lk-result ok';
    el.innerHTML = `✓ In QuickBooks as <strong>${escapeHtml(r.match)}</strong>`;
    return;
  }
  el.className = 'lk-result missing';
  el.innerHTML = '✗ Not in QuickBooks'
    + (r.suggestions.length ? ` -- did you mean ${r.suggestions.map((s) => `<strong>${escapeHtml(s)}</strong>`).join(', ')}?` : '.');
}

function check(kind, value) {
  if (!value.trim()) { showResult(kind, null); return; }
  lookupUrl('/api/lookup/check', { [kind]: value })
    .then((data) => {
      showResult(kind, data.results[kind]);
      if (data.fetched_at) {
        document.getElementById('lk-age').textContent =
          `QuickBooks lists as of ${new Date(data.fetched_at * 1000).toLocaleString()}.`;
      }
    })
    .catch((e) => { document.getElementById(`lk-${kind}-result`).textContent = e.message; });
}

function setup(input) {
  const kind = input.dataset.kind;
  const box = document.getElementById(`lk-${kind}-suggestions`);
  let timer = null;
  const hide = () => { box.classList.remove('open'); box.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    showResult(kind, null);
    const term = input.value.trim();
    if (term.length < 2) { hide(); return; }
    timer = setTimeout(() => {
      lookupUrl(`/api/lookup/${kind}`, { q: term }).then((hits) => {
        if (input.value.trim() !== term) return;
        box.innerHTML = '';
        hits.slice(0, 10).forEach((h) => {
          const div = document.createElement('div');
          div.className = 'suggestion';
          div.textContent = h.label;
          div.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = h.value;
            hide();
            check(kind, h.value);
          });
          box.appendChild(div);
        });
        box.classList.toggle('open', hits.length > 0);
      }).catch(() => hide());
    }, 200);
  });
  input.addEventListener('blur', () => setTimeout(() => { hide(); check(kind, input.value); }, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  document.querySelectorAll('input[data-kind]').forEach((input) => {
    setup(input);
    const preset = params.get(input.dataset.kind);
    if (preset) { input.value = preset; check(input.dataset.kind, preset); }
  });
});
