// Commission Bills page: upload workbook + scanned support, check, post bills, attach support.
let jobId = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function call(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.open('/login', '_blank');
    throw new Error('Your login expired. Log in again in the new tab, then retry here.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(text, isError) {
  const el = $('commission-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger, #b3432f)' : '';
}

function list(items) {
  return `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function renderCheck(check, posted) {
  $('commission-result-card').style.display = '';
  $('commission-summary-title').textContent =
    `${check.bills.length} bills, $${money(check.total)} -- due ${check.due_date} (${check.rows} rows)`;

  const created = {};
  ((posted && posted.results) || []).forEach((r) => { created[`${r.doc}|${r.vendor}`] = r; });
  $('commission-bills-body').innerHTML = check.bills.map((b) => {
    const p = created[`${b.doc}|${b.vendor}`];
    let status = b.already ? 'Already in QuickBooks' : 'Ready';
    if (p) status = p.result === 'created' ? `Created #${escapeHtml(p.id)}${p.warning ? ' -- ' + escapeHtml(p.warning) : ''}`
      : p.result === 'failed' ? `<span style="color:#b3432f">Failed: ${escapeHtml(p.error)}</span>` : escapeHtml(p.result);
    return `<tr><td>${b.row}</td><td>${escapeHtml(b.doc)}</td><td>${b.date}</td><td>${escapeHtml(b.vendor)}</td>
      <td class="amount-cell">${money(b.amount)}</td><td title="${escapeHtml(b.description)}">${escapeHtml(b.customer)}</td>
      <td>${escapeHtml(b.q)}</td><td>${status}</td></tr>`;
  }).join('');
  $('commission-vendor-body').innerHTML = check.by_vendor.map((v) =>
    `<tr><td>${escapeHtml(v.vendor)}</td><td>${v.bills}</td><td class="amount-cell">${money(v.amount)}</td></tr>`).join('')
    + `<tr><td><b>Total</b></td><td><b>${check.bills.length}</b></td><td class="amount-cell"><b>${money(check.total)}</b></td></tr>`;

  const parts = [];
  if (!check.q_field) parts.push('<p><b>Q Number box not found</b> on recent bills -- bills will be created without it.</p>');
  if (check.problems.length) {
    parts.push('<p><b>Rows that will not be billed until fixed:</b></p>' + list(check.problems.map((p) =>
      `Row ${p.row} ${escapeHtml(p.doc)} (${escapeHtml(p.rep)}, $${money(p.amount)}): ${escapeHtml(p.why)}`)));
  }
  const s = check.support;
  if (s) {
    if (s.missing.length) {
      parts.push(`<p><b>Missing support</b> (on the sheet, no page in the ${s.pages}-page scan):</p>` + list(s.missing.map((m) =>
        `${escapeHtml(m.doc)} -- ${escapeHtml(m.rep)} $${money(m.amount)} ${escapeHtml(m.customer)}`)));
    }
    if (s.extra.length) {
      parts.push('<p><b>In the scan but not on the sheet</b> (possible missing commission):</p>' + list(s.extra.map((e) =>
        `${escapeHtml(e.number)} -- page(s) ${e.pages.join(', ')}`)));
    }
    if (s.notes.length) parts.push('<p><b>Pages to look at:</b></p>' + list(s.notes.map(escapeHtml)));
    if (!s.missing.length && !s.extra.length && !s.notes.length) {
      parts.push(`<p>Support: every invoice has pages in the ${s.pages}-page scan, nothing extra found.</p>`);
    }
  } else {
    parts.push('<p class="hint">No support scan uploaded -- Attach is not available for this run.</p>');
  }
  $('commission-findings').innerHTML = parts.join('');
  $('commission-attach-btn').disabled = !s || !posted;
  $('commission-post-btn').disabled = !!posted && posted.failed === 0;
}

function renderSteps(job) {
  const out = [];
  if (job.post) {
    out.push(`<p><b>Posted:</b> ${job.post.created} created, ${job.post.skipped} already in QuickBooks, `
      + `${job.post.failed} failed${job.post.problems ? `, ${job.post.problems} row(s) not billable` : ''}.</p>`);
  }
  if (job.attach) {
    const a = job.attach;
    out.push(`<p><b>Support attached:</b> ${a.attached.length} bill(s), ${a.skipped} already had it.</p>`);
    if (a.no_file.length) out.push('<p>No support pages for: ' + a.no_file.map(escapeHtml).join(', ') + '</p>');
    if (a.not_posted.length) out.push('<p>Not in QuickBooks yet: ' + a.not_posted.map(escapeHtml).join(', ') + '</p>');
  }
  $('commission-step-results').innerHTML = out.join('');
}

async function poll() {
  clearTimeout(pollTimer);
  if (!jobId) return;
  try {
    const job = await call(`/api/commissions/${jobId}`);
    if (job.check) renderCheck(job.check, job.post);
    renderSteps(job);
    const st = job.status || {};
    const label = { check: 'Checking', post: 'Posting bills', attach: 'Attaching support' }[st.step] || st.step;
    if (st.state === 'running') {
      setStatus(`${label}... (a long scan can take a few minutes)`);
      $('commission-post-btn').disabled = true;
      $('commission-attach-btn').disabled = true;
      pollTimer = setTimeout(poll, 2500);
    } else if (st.state === 'error') {
      setStatus(`${label} failed: ${st.error}`, true);
    } else {
      setStatus(st.step === 'post' ? 'Bills posted -- review the Status column, then Attach support.'
        : st.step === 'attach' ? 'Support attached.' : 'Check done -- review below, then Post bills.');
    }
  } catch (e) {
    setStatus(e.message, true);
  }
}

$('commission-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('Uploading...');
  $('commission-result-card').style.display = 'none';
  try {
    const data = await call('/api/commissions', { method: 'POST', body: new FormData(e.target) });
    jobId = data.id;
    history.replaceState(null, '', `?run=${jobId}`);
    poll();
  } catch (err) {
    setStatus(err.message, true);
  }
});

async function runStep(step, confirmText) {
  if (!jobId || !confirm(confirmText)) return;
  try {
    await call(`/api/commissions/${jobId}/${step}`, { method: 'POST' });
    poll();
  } catch (err) {
    setStatus(err.message, true);
  }
}

$('commission-post-btn').addEventListener('click', () =>
  runStep('post', 'Create these bills in QuickBooks? Bills already there are skipped.'));
$('commission-attach-btn').addEventListener('click', () =>
  runStep('attach', 'Attach each invoice\'s support pages to its bills in QuickBooks?'));

// Reopen a run after a refresh (?run=<id>).
const params = new URLSearchParams(location.search);
if (params.get('run')) { jobId = params.get('run'); poll(); }
