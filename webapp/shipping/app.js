/* =========================================================================
   Shipping calculator UI: upload -> extract text -> review -> results.
   All pricing lives in pricing.js and all document parsing in parser.js;
   this file only reads/writes the page.
   ========================================================================= */
(function () {
  'use strict';
  const P = window.ShippingPricing;
  const S = window.ShippingParser;
  const $ = (id) => document.getElementById(id);

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ---- PDF / OCR text extraction ---- */

  // Rebuild visual rows from the PDF text layer (items within 4pt of the same
  // y are one row, ordered left to right) so labels and values stay together.
  async function extractTextFromFile(file) {
    if (file.type === 'application/pdf') {
      if (!window.pdfjsLib) throw new Error('the PDF reader failed to load (check your internet connection)');
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        const items = content.items
          .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
          .filter((it) => it.str.trim().length)
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const rows = [];
        let current = [], lastY = null;
        items.forEach((it) => {
          if (lastY === null || Math.abs(it.y - lastY) < 4) current.push(it);
          else { rows.push(current); current = [it]; }
          lastY = it.y;
        });
        if (current.length) rows.push(current);
        rows.forEach((row) => {
          row.sort((a, b) => a.x - b.x);
          text += row.map((it) => it.str).join('  ') + '\n';
        });
      }
      return text.replace(/[ \t]{2,}/g, ' ');
    }
    if (!window.Tesseract) throw new Error('the image reader failed to load (check your internet connection)');
    const result = await Tesseract.recognize(file, 'eng');
    return result.data.text.replace(/[ \t]{2,}/g, ' ');
  }

  /* ---- small helpers ---- */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(v) {
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function renderConfidenceBanner(el, level, issues) {
    const list = '<ul class="confList">' + issues.map((i) => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>';
    if (level === 'high') el.innerHTML = '<div class="confBanner confHigh">&#10003;&nbsp; High Confidence — all required information was found.</div>';
    else if (level === 'review') el.innerHTML = '<div class="confBanner confReview"><div class="confTitle">!&nbsp; Review Required</div>' + list + '</div>';
    else el.innerHTML = '<div class="confBanner confCritical"><div class="confTitle">Shipping cannot be calculated reliably yet</div>' + list + '</div>';
  }

  function renderLog(lines) {
    $('logPanel').innerHTML = lines.map((l) => {
      let html = escapeHtml(l)
        .replace(/\$[\d,]+\.\d{2}/g, (m) => '<strong class="amt">' + m + '</strong>')
        .replace(/\bOVERSIZE\b/g, (m) => '<span class="warn">' + m + '</span>');
      return '<div class="logRow"><span class="logDot"></span><div class="logText">' + html + '</div></div>';
    }).join('');
  }

  /* ---- views ---- */

  const views = ['upload', 'processing', 'review', 'results', 'failure'];
  function showView(name) {
    views.forEach((v) => { $('view-' + v).style.display = v === name ? '' : 'none'; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('formulaVersionTag').textContent = P.FORMULA_VERSION;

  const app = {
    file: null,
    parsed: null, // raw parse output, never mutated — used to detect manual overrides
    lastSummary: null,
  };

  /* ---- upload / drag-drop ---- */

  const dropzone = $('dropzone');
  const uploadError = $('uploadError');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pdf,.png,.jpg,.jpeg';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  function showUploadError(msg) {
    uploadError.style.display = 'block';
    uploadError.textContent = msg;
  }
  function fmtSize(bytes) {
    return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function extBadge(name) {
    const m = name.match(/\.([a-zA-Z0-9]+)$/);
    const ext = m ? m[1].toUpperCase() : 'FILE';
    return ext === 'JPEG' ? 'JPG' : ext;
  }
  function setFile(file) {
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) {
      showUploadError("We couldn't read that file. Try exporting the Sales Order as a PDF, JPG, or PNG and upload it again.");
      return;
    }
    uploadError.style.display = 'none';
    app.file = file;
    $('fileIconBadge').textContent = extBadge(file.name);
    $('fileNameText').textContent = file.name;
    $('fileSizeText').textContent = fmtSize(file.size);
    $('dropzoneEmpty').style.display = 'none';
    $('dropzoneFile').style.display = 'block';
  }
  function resetToUpload() {
    app.file = null;
    app.parsed = null;
    $('dropzoneEmpty').style.display = '';
    $('dropzoneFile').style.display = 'none';
    uploadError.style.display = 'none';
    fileInput.value = '';
    showView('upload');
  }

  $('chooseFileBtn').addEventListener('click', () => fileInput.click());
  $('replaceFileBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) setFile(fileInput.files[0]); });
  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag');
  }));
  ['dragleave', 'dragend'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });
  $('backToUploadBtn').addEventListener('click', resetToUpload);
  $('uploadAnotherBtn').addEventListener('click', resetToUpload);
  $('failBackBtn').addEventListener('click', () => showView('review'));

  /* ---- processing ---- */

  function setProgress(pct, stepText) {
    $('progressFill').style.width = pct + '%';
    $('processingStep').textContent = stepText;
  }

  $('analyzeBtn').addEventListener('click', async () => {
    if (!app.file) return;
    showView('processing');
    setProgress(15, 'Reading Sales Order...');
    try {
      const text = await extractTextFromFile(app.file);
      setProgress(40, 'Finding shipping destination...');
      await wait(180);
      setProgress(60, 'Reading door and window quantities...');
      await wait(180);
      const data = S.parseSalesOrder(text);
      setProgress(82, 'Analyzing dimensions...');
      await wait(180);
      setProgress(96, 'Calculating crate requirements...');
      await wait(180);
      setProgress(100, 'Done');
      await wait(150);
      app.parsed = data;
      populateReview(data);
      showView('review');
    } catch (err) {
      showView('upload');
      showUploadError("We couldn't read that file: " + err.message + '. Try exporting the Sales Order as a PDF and upload it again.');
    }
  });

  /* ---- review ---- */

  const f = {};
  ['city', 'state', 'zip', 'doors', 'windows', 'panelW', 'panelH', 'oversize', 'doorCrates', 'windowCrates', 'trackCrates']
    .forEach((k) => { f[k] = $('f_' + k); });

  function distanceLabel(reg) {
    if (reg.region === 'hawaii') return 'Region formula (Hawaii — ocean/LCL)';
    if (reg.region === 'alaska') return 'Region formula (Alaska — barge)';
    if (!reg.resolved) return 'Unknown — enter a valid state/province';
    return 'Est. ' + reg.distance.toLocaleString() + ' mi';
  }
  function refreshDistanceDisplay() {
    $('f_distanceDisplay').textContent = distanceLabel(P.resolveRegion(f.state.value));
  }

  function populateReview(data) {
    f.city.value = data.addr.city || '';
    f.state.value = data.addr.state || '';
    f.zip.value = data.addr.zip || '';
    refreshDistanceDisplay();
    f.doors.value = data.totalDoors;
    f.windows.value = data.totalWindows;
    $('f_areaDisplay').textContent = data.totalAreaSqft.toFixed(0) + ' sqft';
    f.panelW.value = data.maxPanelWidth || '';
    f.panelH.value = data.maxPanelHeight || '';
    f.oversize.value = data.oversize ? 'yes' : 'no';
    f.doorCrates.value = data.doorCrates;
    f.windowCrates.value = data.windowCrates;
    f.trackCrates.value = data.trackCrates;
    ['f_doors_note', 'f_windows_note'].forEach((id) => { $(id).style.display = 'none'; });
    recheckReviewConfidence();
  }

  function markOverride(inputEl, noteId, originalVal) {
    const changed = originalVal != null && String(inputEl.value) !== String(originalVal);
    $(noteId).style.display = changed ? 'block' : 'none';
  }

  /** Order data as currently shown (and possibly edited) on the review screen. */
  function buildDataFromReview() {
    const int = (el) => Math.max(0, parseInt(el.value, 10) || 0);
    const num = (el) => Math.max(0, parseFloat(el.value) || 0);
    const state = f.state.value.trim().toUpperCase();
    const reg = P.resolveRegion(state);
    const doorCrates = int(f.doorCrates), windowCrates = int(f.windowCrates), trackCrates = int(f.trackCrates);
    const p = app.parsed || {};
    return {
      addr: { city: f.city.value.trim(), state, zip: f.zip.value.trim() },
      region: reg.region,
      distance: reg.distance === null ? 0 : reg.distance,
      totalDoors: int(f.doors),
      totalWindows: int(f.windows),
      totalAreaSqft: p.totalAreaSqft || 0,
      oversize: f.oversize.value === 'yes',
      crateCost: P.crateCost(doorCrates, windowCrates, trackCrates),
      doorCrates, windowCrates, trackCrates,
      crateSize: P.crateSizeFromPanel(num(f.panelW), num(f.panelH)),
      lineNum: p.lineNum || 0,
      actualCrating: p.actualCrating ?? null,
      actualShipping: p.actualShipping ?? null,
      summaryFound: p.summaryFound !== false,
    };
  }

  function recheckReviewConfidence() {
    const conf = S.validateData(buildDataFromReview());
    renderConfidenceBanner($('confidenceBannerReview'), conf.level, conf.issues);
    $('calculateBtn').disabled = conf.level === 'critical';
    return conf.level;
  }

  f.state.addEventListener('input', () => { refreshDistanceDisplay(); recheckReviewConfidence(); });
  f.doors.addEventListener('input', () => { markOverride(f.doors, 'f_doors_note', app.parsed && app.parsed.totalDoors); recheckReviewConfidence(); });
  f.windows.addEventListener('input', () => { markOverride(f.windows, 'f_windows_note', app.parsed && app.parsed.totalWindows); recheckReviewConfidence(); });
  [f.panelW, f.panelH].forEach((el) => el.addEventListener('input', recheckReviewConfidence));

  $('calculateBtn').addEventListener('click', () => {
    if (recheckReviewConfidence() === 'critical') return;
    const data = buildDataFromReview();
    const calcLog = [];
    const result = P.computeResult(data, (s) => calcLog.push(s));
    const newTotal = result.newShipping + result.newCrating;
    if (!isFinite(newTotal) || newTotal <= 0 || newTotal > 100000) {
      $('failTitle').textContent = 'Shipping cannot be calculated reliably.';
      $('failBody').textContent = 'We calculated an unusually large or invalid shipping amount ($' +
        (isFinite(newTotal) ? newTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 'N/A') +
        '). This usually means one of the review fields is off — go back and double-check the destination, quantities, and dimensions.';
      showView('failure');
      return;
    }
    renderResults(data, result, calcLog);
    showView('results');
  });

  /* ---- results ---- */

  function renderResults(data, result, calcLog) {
    const conf = S.validateData(data);
    renderConfidenceBanner($('confidenceBannerResults'), conf.level, conf.issues);

    const newTotal = result.newShipping + result.newCrating;
    $('heroTotal').textContent = money(newTotal);
    $('heroShipping').textContent = money(result.newShipping);
    $('heroCrating').textContent = money(result.newCrating);
    $('heroMethodVal').textContent = result.shipModeShort;
    $('heroMethodFull').textContent = result.shipMode;

    const shipTo = [data.addr.city, data.addr.state, data.addr.zip].filter(Boolean).join(', ') || 'not detected';
    const distanceText = data.region === 'hawaii' ? 'Region formula (Hawaii)'
      : data.region === 'alaska' ? 'Region formula (Alaska)'
      : 'Est. ' + data.distance.toFixed(0) + ' mi' + (data.region === 'canada' ? ' + cross-border' : '');

    $('r_destination').textContent = shipTo;
    $('r_distance').textContent = distanceText;
    $('r_units').textContent = data.totalDoors + ' / ' + data.totalWindows;
    $('r_mode').textContent = result.shipMode;

    let oversizeText = '';
    if (data.oversize) {
      const R = P.RATES;
      const pct = (m) => '+' + Math.round((m - 1) * 100) + '%';
      oversizeText = result.mode === 'ocean' ? pct(R.hawaii.oversizeMultiplier)
        : result.mode === 'barge' ? pct(R.alaska.oversizeMultiplier)
        : result.mode === 'ltl' ? pct(R.ltl.oversizeMultiplier)
        : 'reflected in flatbed/dedicated rate';
    }
    $('r_oversizeBadgeWrap').innerHTML = data.oversize ? '<div class="oversizeBadge">OVERSIZE &middot; ' + oversizeText + '</div>' : '';

    $('r_totalCrates').textContent = result.doorCrates + result.windowCrates + result.trackCrates;
    $('r_doorCrates').textContent = result.doorCrates;
    $('r_windowCrates').textContent = result.windowCrates;
    $('r_trackCrates').textContent = result.trackCrates;
    $('r_maxCrate').textContent = result.crateSize
      ? result.crateSize.length.toFixed(1) + '" L x ' + result.crateSize.width + '" W x ' + result.crateSize.height.toFixed(1) + '" H'
      : 'Not available — panel dimensions not found';

    const usingPrinted = data.actualShipping != null;
    $('compareTitle').textContent = usingPrinted ? 'Current vs Proposed' : 'Previous vs Proposed';
    $('compareColA').textContent = usingPrinted ? 'Current Sales Order' : 'Previous Formula';
    $('compareColB').textContent = 'Proposed Calculation';

    const oldTotal = result.oldShipping + result.oldCrating;
    const diff = newTotal - oldTotal;
    const diffPct = oldTotal ? (diff / oldTotal) * 100 : 0;
    $('compareBody').innerHTML =
      [['Shipping', result.oldShipping, result.newShipping], ['Crating', result.oldCrating, result.newCrating]]
        .map((r) => '<tr><td>' + r[0] + '</td><td>' + money(r[1]) + '</td><td>' + money(r[2]) + '</td></tr>').join('') +
      '<tr class="total"><td>Total</td><td>' + money(oldTotal) + '</td><td>' + money(newTotal) + '</td></tr>' +
      '<tr><td>Difference</td><td colspan="2" class="' + (diff >= 0 ? 'diffUp' : 'diffDown') + '">' +
      (diff >= 0 ? '+' : '-') + money(Math.abs(diff)) + ' (' + (diff >= 0 ? '+' : '') + diffPct.toFixed(1) + '%)</td></tr>';

    const sourceNote = $('compareSourceNote');
    sourceNote.style.display = usingPrinted ? 'none' : 'block';
    sourceNote.textContent = usingPrinted ? '' : 'Previous shipping calculated using the legacy formula because no shipping charge was found on the uploaded Sales Order.';

    renderLog(calcLog);
    $('calcFormulaVersion').textContent = 'Calculated with ' + P.FORMULA_VERSION;

    $('orderMatrix').innerHTML = [
      ['Ship to', shipTo],
      ['Distance', distanceText],
      ['Doors / Windows', data.totalDoors + ' / ' + data.totalWindows],
      ['Total area', data.totalAreaSqft.toFixed(0) + ' sqft'],
      ['Oversize', data.oversize ? 'Yes' : 'No'],
      ['Shipping method', result.shipMode],
    ].map((r) => '<tr><td class="k">' + r[0] + '</td><td class="v">' + escapeHtml(r[1]) + '</td></tr>').join('');

    app.lastSummary = [
      'Panda Shipping Calculator — ' + P.FORMULA_VERSION,
      'Destination: ' + shipTo + ' (' + distanceText + ')',
      'Doors / Windows: ' + data.totalDoors + ' / ' + data.totalWindows,
      'Shipping method: ' + result.shipMode,
      'Shipping: ' + money(result.newShipping),
      'Crating: ' + money(result.newCrating),
      'Total: ' + money(newTotal),
    ].join('\n');
  }

  /* ---- collapsibles + copy ---- */

  function wireCollapse(btnId, bodyId) {
    const btn = $(btnId), body = $(bodyId);
    btn.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      btn.classList.toggle('open', !open);
      btn.setAttribute('aria-expanded', String(!open));
    });
  }
  wireCollapse('calcDetailsToggle', 'calcDetailsBody');
  wireCollapse('extractedToggle', 'extractedBody');

  $('copySummaryBtn').addEventListener('click', () => {
    if (!app.lastSummary || !navigator.clipboard) return;
    navigator.clipboard.writeText(app.lastSummary).then(() => {
      const btn = $('copySummaryBtn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  });
})();
