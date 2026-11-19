/* =========================================================================
   Sales Order text -> order data.

   Takes the plain text extracted from a Panda Sales Order (PDF text layer or
   OCR) and pulls out ship-to, door/window counts, dimensions, crates and any
   charges already printed on the document. Pure functions — no DOM — so it
   runs in the browser (window.ShippingParser) and in Node tests.

   Depends on pricing.js for regions, crate rules and the oversize rule.
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pricing.js'));
  else root.ShippingParser = factory(root.ShippingPricing);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const DOOR_KEYWORDS = ['door','hinged','slide','sliding','lift & slide','lift and slide','multi-slide','multi slide','bi-fold','bifold','french','entry','sidelite'];
  const WINDOW_KEYWORDS = ['window','casement','awning','fixed','single hung','double hung','slider','picture'];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noop = () => {};

  /* ---- dimensions ---- */

  // Dimension labels (Frame Dimensions / Panel Dimensions) sometimes wrap across two
  // visual rows in the reconstructed PDF text, e.g. "58 3/32 W x 91" then, several
  // rows later (after unrelated column content), "11/16 H". A single-line regex
  // misses the wrapped remainder, so instead: find "W", find "x", find "H", and
  // independently pull the leading whole number + trailing fraction out of the
  // width segment (before W) and height segment (between x and H).
  function parseWholeAndTrailingFrac(seg) {
    const wholeMatch = seg.match(/\d+/);
    if (!wholeMatch) return null;
    const fracMatch = seg.trim().match(/(\d+)\/(\d+)\s*$/);
    const frac = fracMatch ? parseInt(fracMatch[1], 10) / parseInt(fracMatch[2], 10) : 0;
    return parseInt(wholeMatch[0], 10) + frac;
  }

  function extractDimPair(text, label, windowSize) {
    windowSize = windowSize || 250;
    const idx = text.indexOf(label);
    if (idx === -1) return null;
    const seg = text.slice(idx, idx + windowSize);
    const wIdx = seg.search(/\bW\b/);
    if (wIdx === -1) return null;
    const afterW = seg.slice(wIdx + 1);
    const xIdx = afterW.search(/\bx\b/i);
    if (xIdx === -1) return null;
    const afterX = afterW.slice(xIdx + 1);
    const hIdx = afterX.search(/\bH\b/);
    if (hIdx === -1) return null;
    const w = parseWholeAndTrailingFrac(seg.slice(0, wIdx));
    const h = parseWholeAndTrailingFrac(afterX.slice(0, hIdx));
    if (w === null || h === null) return null;
    return { w, h };
  }

  function extractAllDimPairs(text, label, windowSize) {
    const results = [];
    const re = new RegExp(escapeRe(label), 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const pair = extractDimPair(text.slice(m.index), label, windowSize);
      if (pair) results.push(pair);
      re.lastIndex = m.index + label.length;
    }
    return results;
  }

  /* ---- labelled values ---- */

  function findNear(text, label, windowSize) {
    windowSize = windowSize || 30;
    const idx = text.indexOf(label);
    if (idx === -1) return { before: '', after: '', idx: -1 };
    return {
      before: text.slice(Math.max(0, idx - windowSize), idx),
      after: text.slice(idx + label.length, idx + label.length + windowSize),
      idx,
    };
  }

  function nearbyInt(text, label, windowSize) {
    const w = findNear(text, label, windowSize);
    if (w.idx === -1) return null;
    const re = /(?<![\d.,])(\d{1,3})(?!\d)/g;
    const after = [...w.after.matchAll(re)];
    if (after.length) return parseInt(after[0][1], 10);
    const before = [...w.before.matchAll(re)];
    if (before.length) return parseInt(before[before.length - 1][1], 10);
    return null;
  }

  /** Dollar amount closest to any occurrence of label. */
  function nearbyDollar(text, label, windowSize) {
    windowSize = windowSize || 45;
    let best = null, bestDist = Infinity;
    const re = new RegExp(escapeRe(label), 'gi');
    let m0;
    while ((m0 = re.exec(text)) !== null) {
      const idx = m0.index;
      const regionStart = Math.max(0, idx - windowSize);
      const region = text.slice(regionStart, idx + label.length + windowSize);
      const labelStart = idx - regionStart, labelEnd = labelStart + label.length;
      for (const mm of region.matchAll(/\$?([\d,]+\.\d{2})/g)) {
        const dist = mm.index < labelStart ? labelStart - mm.index : mm.index - labelEnd;
        if (dist < bestDist) { bestDist = dist; best = mm; }
      }
    }
    return best ? parseFloat(best[1].replace(/,/g, '')) : null;
  }

  function extractDoorsWindows(text) {
    const idx1 = text.indexOf('Number of Doors');
    const idx2 = text.indexOf('Project Type');
    if (idx1 !== -1 && idx2 !== -1 && idx2 > idx1) {
      const m = text.slice(idx1, idx2).match(/^\s*(\d{1,3})\s+(\d{1,3})\s*$/m);
      if (m) return { doors: parseInt(m[1], 10), windows: parseInt(m[2], 10) };
    }
    return { doors: nearbyInt(text, 'Number of Doors'), windows: nearbyInt(text, 'Number of Windows') };
  }

  // US: "City, ST 12345"   Canada: "City, ON A1A 1A1". The state and province
  // code sets don't overlap, so one extracted code can't be ambiguous.
  function extractShipTo(text) {
    const US_RE = /([A-Za-z .]{2,40}),\s*([A-Z]{2})\s*,?\s*(\d{5})/;
    const CA_RE = /([A-Za-z .]{2,40}),\s*([A-Z]{2})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/;
    const us = (m) => ({ city: m[1].trim(), state: m[2], zip: m[3], country: 'US' });
    const ca = (m) => ({ city: m[1].trim(), state: m[2], zip: m[3].replace(/\s+/, ' '), country: 'CA' });

    const idx = text.indexOf('Ship To');
    const scoped = idx !== -1 ? text.slice(idx, idx + 500) : text;
    let m = scoped.match(US_RE);
    if (m) return us(m);
    m = scoped.match(CA_RE);
    if (m) return ca(m);

    const allUS = [...text.matchAll(new RegExp(US_RE.source, 'g'))];
    if (allUS.length) return us(allUS[allUS.length - 1]);
    const allCA = [...text.matchAll(new RegExp(CA_RE.source, 'g'))];
    if (allCA.length) return ca(allCA[allCA.length - 1]);
    return { city: null, state: null, zip: null, country: null };
  }

  function classify(blockText) {
    const t = blockText.toLowerCase();
    const doorScore = DOOR_KEYWORDS.filter((k) => t.includes(k)).length;
    const winScore = WINDOW_KEYWORDS.filter((k) => t.includes(k)).length;
    if (doorScore === 0 && winScore === 0) return 'unclassified';
    return doorScore >= winScore ? 'door' : 'window';
  }

  /* ---- whole document ---- */

  function parseSalesOrder(text, log) {
    log = log || noop;
    const addr = extractShipTo(text);
    const resolved = P.resolveRegion(addr.state);
    const region = resolved.region;
    const distance = resolved.distance === null ? 0 : resolved.distance;

    if (region === 'canada') log(`Ship-to detected as Canada (${addr.state}) — using ${resolved.distance} mi base + cross-border surcharge`);
    else if (region === 'hawaii') log('Ship-to state: HI — Hawaii uses its own ocean/LCL formula, not distance-based');
    else if (region === 'alaska') log('Ship-to state: AK — Alaska uses its own barge formula, not distance-based');
    else if (region === 'conus') log(`Ship-to: ${addr.state}${addr.zip ? ' ' + addr.zip : ''} — approx ${resolved.distance} mi one-way from ${P.RATES.origin}`);
    else log(`Could not detect a ship-to state/province on the document — defaulting to ${P.RATES.unknownDistance.toLocaleString()} mi. Verify the destination before trusting this result.`);

    const dw = extractDoorsWindows(text);
    let totalDoors = dw.doors, totalWindows = dw.windows;
    const summaryFound = totalDoors !== null && totalWindows !== null;
    if (summaryFound) log(`From order summary — doors: ${totalDoors}, windows: ${totalWindows}`);
    else log('Could not read "Number of Doors / Windows" from the summary — falling back to per-line classification.');

    const unitSplits = text.split(/(?=UNIT:\s*\d+\s*QTY:\s*\d+)/i).filter((c) => /QTY:\s*\d+/i.test(c));
    const chunks = unitSplits.length ? unitSplits : [text];
    let totalAreaSqft = 0, oversize = false, lineNum = 0, fallbackDoors = 0, fallbackWindows = 0;
    let doorCrates = 0, windowCrates = 0, trackCrates = 0;
    let maxPanelWidth = 0, maxPanelHeight = 0;
    const c = P.RATES.crating;

    chunks.forEach((chunk) => {
      const qtyM = chunk.match(/QTY:\s*(\d+)/i);
      if (!qtyM) return;
      lineNum++;
      const qty = parseInt(qtyM[1], 10);
      const sqftM = chunk.match(/SQFT:\s*(\d+(\.\d+)?)/i);
      let blockArea = sqftM ? parseFloat(sqftM[1]) : 0;
      let maxDim = 0;
      extractAllDimPairs(chunk, 'Frame Dimensions').forEach((d) => {
        if (d.w && d.h) {
          maxDim = Math.max(maxDim, d.w, d.h);
          if (!sqftM) blockArea += (d.w * d.h) / 144;
        }
      });
      extractAllDimPairs(chunk, 'Panel Dimensions').forEach((d) => {
        if (d.w) maxPanelWidth = Math.max(maxPanelWidth, d.w);
        if (d.h) maxPanelHeight = Math.max(maxPanelHeight, d.h);
      });
      totalAreaSqft += blockArea * qty;
      const isOversize = P.isOversizeUnit(maxDim, blockArea);
      if (isOversize) oversize = true;

      const cls = classify(chunk);
      if (cls === 'door') fallbackDoors += qty;
      else if (cls === 'window') fallbackWindows += qty;
      const crates = P.cratesForLine(cls, qty, /\btrack\b/i.test(chunk));
      doorCrates += crates.door; windowCrates += crates.window; trackCrates += crates.track;
      const lineCost = P.crateCost(crates.door, crates.window, crates.track);
      log(`Line ${lineNum}: qty ${qty}, ${cls}, ${blockArea.toFixed(0)} sqft${isOversize ? ' — OVERSIZE' : ''} — ${crates.door || crates.window} panel crate(s)${crates.track ? ' + ' + crates.track + ' track crate(s)' : ''} = $${lineCost.toFixed(2)}`);
    });

    if (!summaryFound) { totalDoors = fallbackDoors; totalWindows = fallbackWindows; }

    const crateCost = P.crateCost(doorCrates, windowCrates, trackCrates);
    log(`Crate count — door crates: ${doorCrates} (${c.doorsPerCrate} doors/crate, $${c.doorCrate} each), window crates: ${windowCrates} (${c.windowsPerCrate} windows/crate, $${c.windowCrate} each), track crates: ${trackCrates} ($${c.trackCrate} each)`);

    const crateSize = P.crateSizeFromPanel(maxPanelWidth, maxPanelHeight);
    if (crateSize) {
      log(`Largest panel: ${maxPanelWidth.toFixed(1)}" W x ${maxPanelHeight.toFixed(1)}" H — plus ${c.padding}" per side — estimated max crate: ${crateSize.length.toFixed(1)}" L x ${crateSize.width}" W x ${crateSize.height.toFixed(1)}" H`);
    } else {
      log('Could not find "Panel Dimensions" on the document — maximum crate size not calculated.');
    }

    const actualCrating = nearbyDollar(text, 'Crating:');
    let actualShipping = nearbyDollar(text, 'Est. Shipping:');
    if (actualShipping === null) actualShipping = nearbyDollar(text, 'Estimated Shipping:');
    if (actualShipping === null) actualShipping = nearbyDollar(text, 'Shipping:');
    const grandTotal = nearbyDollar(text, 'Grand Total');
    if (actualCrating !== null) log(`Document shows crating charged: $${actualCrating.toFixed(2)}`);
    if (actualShipping !== null) log(`Document shows shipping charged: $${actualShipping.toFixed(2)}`);
    if (grandTotal !== null) log(`Document grand total: $${grandTotal.toFixed(2)}`);

    return {
      addr, region, distance, totalDoors, totalWindows, totalAreaSqft, oversize,
      crateCost, doorCrates, windowCrates, trackCrates, crateSize,
      maxPanelWidth: maxPanelWidth || null, maxPanelHeight: maxPanelHeight || null,
      lineNum, actualCrating, actualShipping, grandTotal, summaryFound,
    };
  }

  /** How much to trust a parsed (or hand-edited) order. */
  function validateData(data) {
    const issues = [];
    let level = 'high';
    if (!P.resolveRegion(data.addr && data.addr.state).resolved) {
      level = 'critical';
      issues.push('We could not identify the shipping destination. Enter a valid state or province code.');
    }
    if (data.lineNum === 0) {
      level = 'critical';
      issues.push("We couldn't find any door or window line items on this document.");
    }
    if (level !== 'critical') {
      if (data.totalDoors === 0 && data.totalWindows === 0) {
        level = 'review';
        issues.push('No doors or windows were detected on this order — please confirm the counts.');
      }
      if (!data.summaryFound) {
        level = 'review';
        issues.push('Door/window counts came from per-line detection rather than the order summary — please confirm.');
      }
      if (!data.crateSize) {
        level = 'review';
        issues.push('Panel dimensions were not found — the maximum crate size could not be estimated.');
      }
      if (data.actualShipping == null) {
        level = 'review';
        issues.push('No shipping charge was found on the document — the comparison will use the legacy formula instead of a printed value.');
      }
    }
    return { level, issues };
  }

  return {
    DOOR_KEYWORDS, WINDOW_KEYWORDS,
    parseWholeAndTrailingFrac, extractDimPair, extractAllDimPairs, findNear, nearbyInt, nearbyDollar,
    extractDoorsWindows, extractShipTo, classify, parseSalesOrder, validateData,
  };
});
