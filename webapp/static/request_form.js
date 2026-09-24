// Public purchase request form (no login -- the page link carries FORM_KEY).
// Submits into the PO Requests review queue; nothing goes to QuickBooks until
// purchasing creates the PO from it.

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
let files = [];

function addLine() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="rf-item" placeholder="What's needed"></td>
    <td><input type="text" class="rf-desc"></td>
    <td><input type="number" class="rf-qty" min="0" step="any" value="1" style="width:70px;"></td>
    <td><button type="button" class="row-remove" aria-label="Remove line">×</button></td>`;
  tr.querySelector('.row-remove').addEventListener('click', () => {
    const body = document.getElementById('rf-lines-body');
    if (body.children.length > 1) tr.remove();
    else tr.querySelectorAll('input').forEach((i) => { i.value = i.classList.contains('rf-qty') ? '1' : ''; });
  });
  document.getElementById('rf-lines-body').appendChild(tr);
}

function renderFiles() {
  const list = document.getElementById('rf-file-list');
  list.innerHTML = '';
  files.forEach((file, idx) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => { files.splice(idx, 1); renderFiles(); });
    li.append(name, remove);
    list.appendChild(li);
  });
}

function showError(message) {
  const el = document.getElementById('rf-error');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
  if (message) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function collect() {
  const value = (id) => document.getElementById(id).value.trim();
  const lines = [...document.querySelectorAll('#rf-lines-body tr')].map((tr) => ({
    item_name: tr.querySelector('.rf-item').value.trim(),
    description: tr.querySelector('.rf-desc').value.trim(),
    qty: parseFloat(tr.querySelector('.rf-qty').value) || 0,
  })).filter((l) => l.item_name || l.description);
  return {
    requester_name: value('rf-name'), requester_email: value('rf-email'),
    vendor_name: value('rf-vendor'), q_project: value('rf-project'),
    location: value('rf-location'), needed_by: value('rf-needed-by'),
    memo: value('rf-notes'), lines,
  };
}

function validate(data) {
  if (!data.requester_name) return 'Enter your name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.requester_email)) return 'Enter a valid email address.';
  if (!data.vendor_name) return 'Enter the vendor.';
  if (!data.lines.length) return 'Add at least one item.';
  if (data.lines.some((l) => l.qty <= 0)) return 'Every item needs a quantity of more than 0.';
  return '';
}

function submit(e) {
  e.preventDefault();
  const data = collect();
  const problem = validate(data);
  showError(problem);
  if (problem) return;

  const body = new FormData();
  body.append('data', JSON.stringify(data));
  files.forEach((f) => body.append('files', f));
  const btn = document.getElementById('rf-submit');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  fetch(`/api/request-form?key=${encodeURIComponent(FORM_KEY)}`, { method: 'POST', body })
    .then(async (res) => {
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Could not send the request (${res.status}).`);
      document.getElementById('rf-form').style.display = 'none';
      document.getElementById('rf-done-text').textContent = `Thanks, ${data.requester_name}. Your request is number `
        + `${out.number}. Purchasing will review it and contact you at ${data.requester_email} if they have questions.`;
      document.getElementById('rf-done').style.display = 'block';
      window.scrollTo(0, 0);
    })
    .catch((err) => showError(err.message))
    .finally(() => { btn.disabled = false; btn.textContent = 'Submit Request'; });
}

function resetForm() {
  const keep = { name: document.getElementById('rf-name').value, email: document.getElementById('rf-email').value };
  document.getElementById('rf-form').reset();
  document.getElementById('rf-name').value = keep.name;
  document.getElementById('rf-email').value = keep.email;
  document.getElementById('rf-lines-body').innerHTML = '';
  addLine();
  files = [];
  renderFiles();
  showError('');
  document.getElementById('rf-done').style.display = 'none';
  document.getElementById('rf-form').style.display = 'block';
}

document.addEventListener('DOMContentLoaded', () => {
  addLine();
  document.getElementById('rf-add-line').addEventListener('click', addLine);
  document.getElementById('rf-file-btn').addEventListener('click', () => document.getElementById('rf-file-input').click());
  document.getElementById('rf-file-input').addEventListener('change', (e) => {
    const picked = [...e.target.files];
    e.target.value = '';
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) showError(`Too large (25MB limit): ${tooBig.map((f) => f.name).join(', ')}`);
    files.push(...picked.filter((f) => f.size <= MAX_FILE_BYTES));
    if (files.length > MAX_FILES) {
      files = files.slice(0, MAX_FILES);
      showError(`Only ${MAX_FILES} files can be attached.`);
    }
    renderFiles();
  });
  document.getElementById('rf-form').addEventListener('submit', submit);
  document.getElementById('rf-form').addEventListener('input', () => showError(''));
  document.getElementById('rf-another').addEventListener('click', resetForm);
});
