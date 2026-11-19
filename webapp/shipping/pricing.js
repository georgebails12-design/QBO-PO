/* =========================================================================
   Panda shipping & crating pricing — the formula, in one place.

   Every rate, threshold and distance in the model lives in RATES below. To
   change pricing, change a number here, bump FORMULA_VERSION, update
   shipping/README.md, and run the tests (`node --test webapp/shipping/test/pricing.test.js`).
   The worked examples in the tests come from the v2 pricing proposal; if a
   change is meant to move one of them, update the expected value in the same
   commit so the change is visible in review.

   No DOM, no network: this file runs unchanged in the browser (classic
   <script>, exposes window.ShippingPricing) and in Node (require()).
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShippingPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMULA_VERSION = 'Shipping Model v2.1';

  const RATES = {
    origin: 'Las Vegas, NV 89030',

    // Distance used when the ship-to can't be resolved (the review screen
    // blocks calculation in that case, so this only shows up in logs).
    unknownDistance: 2000,

    // Tapered per-unit pricing: rate * count^exponent.
    taperExponent: 0.75,

    ltl: {
      minimum: 1200,
      perDoor: 280,
      perWindow: 180,
      oversizeMultiplier: 1.25,
      // [max one-way miles, base rate]; first band whose max >= d wins.
      bands: [
        [150, 750], [300, 1050], [500, 1300], [750, 1500], [1000, 1700],
        [1500, 1950], [2000, 2200], [2500, 2450], [3000, 2650],
      ],
      // Beyond the last band: last rate + perStep for every (partial) step miles.
      beyond: { perStep: 150, stepMiles: 250 },
    },

    dedicated: {
      perMile: 2.60,
      minimum: 1600,
      minCrates: 6,   // 6+ crates  -> dedicated truck
      minUnits: 12,   // or 12+ doors+windows
    },

    flatbed: {
      perMile: 3.20,
      handling: 350,
      minimum: 1900,
      // NOTE: the calculator applies the minimum to the mileage only and adds
      // handling on top: max(minimum, perMile*d) + handling. The v2 proposal
      // PDF's pseudocode writes max(minimum, perMile*d + handling) instead.
      // They differ for flatbed runs under ~594 mi. Kept as the calculator
      // had it; see README "Open questions".
      minimumIncludesHandling: false,
      maxCrateHeight: 100, // crate height > this -> flatbed
      maxCrateLength: 280, // crate length > this -> flatbed
    },

    hawaii: { base: 4800, perDoor: 420, perWindow: 270, oversizeMultiplier: 1.2 },
    alaska: { base: 4200, perDoor: 380, perWindow: 240, oversizeMultiplier: 1.2 },

    canada: { surchargeMin: 400, surchargePct: 0.25 },

    // A unit is "oversize" if any frame dimension > maxDimension inches or its
    // area > maxSqft. Separate from the flatbed trigger above.
    oversize: { maxDimension: 100, maxSqft: 40 },

    crating: {
      doorsPerCrate: 8,
      windowsPerCrate: 10,
      doorCrate: 480,
      windowCrate: 480,
      trackCrate: 300,
      padding: 10,     // inches added on every side of the largest panel
      crateWidth: 45,  // inches, fixed
    },
  };

  // Approximate one-way road miles from 89030. null = priced by region formula.
  const STATE_DISTANCE = {
    AL:1900, AK:null, AZ:300, AR:1500, CA:400, CO:750, CT:2600, DE:2400, FL:2400, GA:1900,
    HI:null, ID:640, IL:1750, IN:1800, IA:1500, KS:1200, KY:1900, LA:1700, ME:2900, MD:2400,
    MA:2713, MI:2000, MN:1700, MS:1700, MO:1600, MT:950, NE:1300, NV:100, NH:2700, NJ:2500,
    NM:600, NY:2529, NC:2100, ND:1500, OH:2000, OK:1200, OR:1000, PA:2400, RI:2650, SC:2200,
    SD:1300, TN:1750, TX:1250, UT:420, VT:2750, VA:2300, WA:1120, WV:2100, WI:1850, WY:800, DC:2350,
  };
  const CANADA_DISTANCE = {
    BC:900, AB:1300, SK:1700, MB:2000, ON:2400, QC:2700, NB:3000, NS:3200, PE:3100, NL:3400, YT:1800, NT:2200, NU:2800,
  };

  const MODE_LABELS = {
    ocean:     { short: 'OCEAN',   full: 'Ocean / LCL' },
    barge:     { short: 'BARGE',   full: 'Barge' },
    flatbed:   { short: 'FLATBED', full: 'Flatbed (open-deck)' },
    dedicated: { short: 'FTL',     full: 'Dedicated truck (FTL)' },
    ltl:       { short: 'LTL',     full: 'LTL (shared trailer)' },
  };

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const noop = () => {};

  /** State/province code -> {region, distance, resolved}. */
  function resolveRegion(stateCode) {
    if (!stateCode) return { region: 'unknown', distance: RATES.unknownDistance, resolved: false };
    const sc = String(stateCode).trim().toUpperCase();
    if (sc === 'HI') return { region: 'hawaii', distance: null, resolved: true };
    if (sc === 'AK') return { region: 'alaska', distance: null, resolved: true };
    if (has(STATE_DISTANCE, sc)) return { region: 'conus', distance: STATE_DISTANCE[sc], resolved: true };
    if (has(CANADA_DISTANCE, sc)) return { region: 'canada', distance: CANADA_DISTANCE[sc], resolved: true };
    return { region: 'unknown', distance: RATES.unknownDistance, resolved: false };
  }

  /** count^exponent * rate, or 0 when count is 0. */
  function taper(rate, count) {
    return count > 0 ? rate * Math.pow(count, RATES.taperExponent) : 0;
  }

  /** LTL distance-band base rate for one-way miles d. */
  function ltlBand(d) {
    const { bands, beyond } = RATES.ltl;
    for (const [maxMiles, rate] of bands) if (d <= maxMiles) return rate;
    const [lastMax, lastRate] = bands[bands.length - 1];
    return lastRate + beyond.perStep * Math.ceil((d - lastMax) / beyond.stepMiles);
  }

  /** LTL price before any Canada surcharge. */
  function ltlPrice(d, doors, windows, oversize) {
    const r = RATES.ltl;
    let subtotal = ltlBand(d) + taper(r.perDoor, doors) + taper(r.perWindow, windows);
    if (oversize) subtotal *= r.oversizeMultiplier;
    return Math.max(r.minimum, subtotal);
  }

  function flatbedPrice(d) {
    const r = RATES.flatbed;
    return r.minimumIncludesHandling
      ? Math.max(r.minimum, r.perMile * d + r.handling)
      : Math.max(r.minimum, r.perMile * d) + r.handling;
  }

  function dedicatedPrice(d) {
    const r = RATES.dedicated;
    return Math.max(r.minimum, r.perMile * d);
  }

  function islandPrice(region, doors, windows, oversize) {
    const r = RATES[region];
    let price = r.base + taper(r.perDoor, doors) + taper(r.perWindow, windows);
    if (oversize) price *= r.oversizeMultiplier;
    return price;
  }

  function canadaSurcharge(price) {
    const r = RATES.canada;
    return Math.max(r.surchargeMin, price * r.surchargePct);
  }

  /** Physical crate size from the largest panel width/height on the order. */
  function crateSizeFromPanel(maxPanelWidth, maxPanelHeight) {
    if (!(maxPanelWidth > 0 && maxPanelHeight > 0)) return null;
    const pad = 2 * RATES.crating.padding;
    const pw = maxPanelWidth + pad, ph = maxPanelHeight + pad;
    return { length: Math.max(pw, ph), height: Math.min(pw, ph), width: RATES.crating.crateWidth };
  }

  /** Crates needed for one line item. cls: 'door' | 'window' | 'unclassified'. */
  function cratesForLine(cls, qty, hasTrack) {
    const c = RATES.crating;
    const out = { door: 0, window: 0, track: 0 };
    if (cls === 'window') out.window = Math.ceil(qty / c.windowsPerCrate);
    else {
      // Unclassified lines are crated as doors (the conservative choice).
      out.door = Math.ceil(qty / c.doorsPerCrate);
      if (cls === 'door' && hasTrack) out.track = Math.ceil(qty / c.doorsPerCrate);
    }
    return out;
  }

  function crateCost(doorCrates, windowCrates, trackCrates) {
    const c = RATES.crating;
    return doorCrates * c.doorCrate + windowCrates * c.windowCrate + trackCrates * c.trackCrate;
  }

  function isOversizeUnit(maxDimension, sqft) {
    return maxDimension > RATES.oversize.maxDimension || sqft > RATES.oversize.maxSqft;
  }

  /**
   * Which mode Panda would book. Hawaii/Alaska are always ocean/barge.
   * order: {region, crateSize, doorCrates, windowCrates, trackCrates, totalDoors, totalWindows}
   */
  function determineShipMode(order) {
    if (order.region === 'hawaii') return 'ocean';
    if (order.region === 'alaska') return 'barge';
    const cs = order.crateSize;
    const fb = RATES.flatbed, ded = RATES.dedicated;
    if (cs && (cs.height > fb.maxCrateHeight || cs.length > fb.maxCrateLength)) return 'flatbed';
    const totalCrates = (order.doorCrates || 0) + (order.windowCrates || 0) + (order.trackCrates || 0);
    const totalUnits = (order.totalDoors || 0) + (order.totalWindows || 0);
    if (totalCrates >= ded.minCrates || totalUnits >= ded.minUnits) return 'dedicated';
    return 'ltl';
  }

  const usd = (v) => '$' + v.toFixed(2);

  /**
   * The new shipping price. Returns {shipping, mode}. log(msg) receives a
   * human-readable explanation of each step.
   */
  function shippingPrice(order, log) {
    log = log || noop;
    const doors = order.totalDoors || 0, windows = order.totalWindows || 0;
    const mode = determineShipMode(order);
    let shipping;

    if (mode === 'ocean' || mode === 'barge') {
      const region = mode === 'ocean' ? 'hawaii' : 'alaska';
      const r = RATES[region];
      shipping = islandPrice(region, doors, windows, order.oversize);
      log(`Mode: ${mode === 'ocean' ? 'ocean/LCL (Hawaii)' : 'barge (Alaska)'} — $${r.base.toLocaleString()} base + tapered per-unit ($${r.perDoor} x doors^${RATES.taperExponent}, $${r.perWindow} x windows^${RATES.taperExponent})${order.oversize ? `, oversize x${r.oversizeMultiplier}` : ''}: ${usd(shipping)}`);
      return { shipping, mode };
    }

    const d = order.distance || 0;
    if (mode === 'flatbed') {
      const r = RATES.flatbed, cs = order.crateSize;
      shipping = flatbedPrice(d);
      const why = cs.height > r.maxCrateHeight ? cs.height.toFixed(0) + '" tall' : cs.length.toFixed(0) + '" long';
      log(`Mode: flatbed (open-deck) — crate is ${why}, too large for a standard enclosed trailer. $${r.perMile.toFixed(2)}/mi x ${d.toFixed(0)}mi + $${r.handling} tie-down/handling, $${r.minimum.toLocaleString()} minimum: ${usd(shipping)}`);
    } else if (mode === 'dedicated') {
      const r = RATES.dedicated;
      const crates = (order.doorCrates || 0) + (order.windowCrates || 0) + (order.trackCrates || 0);
      shipping = dedicatedPrice(d);
      log(`Mode: dedicated truck (FTL) — ${crates} crates / ${doors + windows} units is past the point LTL stays cost-effective. $${r.perMile.toFixed(2)}/mi x ${d.toFixed(0)}mi, $${r.minimum.toLocaleString()} minimum: ${usd(shipping)}`);
    } else {
      const r = RATES.ltl;
      log(`Mode: LTL (shared trailer) — distance band rate: $${ltlBand(d).toLocaleString()}`);
      shipping = ltlPrice(d, doors, windows, order.oversize);
      log(`Doors: ${doors} (tapered $${r.perDoor}^${RATES.taperExponent}), windows: ${windows} (tapered $${r.perWindow}^${RATES.taperExponent})`);
      if (order.oversize) log(`Oversize multiplier applied: x${r.oversizeMultiplier}`);
    }

    if (order.region === 'canada') {
      const surcharge = canadaSurcharge(shipping);
      shipping += surcharge;
      log(`Cross-border surcharge (customs brokerage + fuel/carrier premium, ${RATES.canada.surchargePct * 100}% or $${RATES.canada.surchargeMin} minimum): +${usd(surcharge)}`);
    }
    log(`New shipping total: ${usd(shipping)}`);
    return { shipping, mode };
  }

  /* ---- Legacy formula (table 301 f(d) x table 303), for old-vs-new comparison only ---- */
  function legacyFd(d) {
    if (d <= 49) return 0.3 + (0.14 / 150) * d;
    if (d <= 249) return 0.396 + (0.176 / 205) * d;
    if (d <= 499) return 0.527 + (0.231 / 250) * (d - 250);
    if (d <= 999) return 0.949;
    return 1.168 + (0.736 / 1400) * (d - 1000);
  }
  function legacyShippingCalc(d, weight, crates) {
    const n = Math.pow(Math.max(crates, 1), 0.765);
    const base = d < 500 ? (0.5 * weight + 619 * n) : (0.08766 * weight + 1000 * n);
    return legacyFd(d) * base;
  }
  /** Legacy price estimated from an order (weight approximated from area). */
  function legacyShipping(order) {
    const weight = (order.totalAreaSqft || 0) * 13.125 * 1.125;
    const crates = Math.max(1, Math.ceil((order.totalDoors || 0) / 8) + Math.ceil((order.totalWindows || 0) / 10));
    const legacyDistance = { hawaii: 2600, alaska: 1500, canada: 2400 };
    const d = has(legacyDistance, order.region) ? legacyDistance[order.region] : (order.distance || 0);
    return legacyShippingCalc(d, weight, crates);
  }

  /**
   * Full old-vs-new comparison for one order (what the results screen shows).
   * order also may carry actualShipping / actualCrating printed on the document.
   */
  function computeResult(order, log) {
    log = log || noop;
    const { shipping, mode } = shippingPrice(order, log);
    const newCrating = crateCost(order.doorCrates || 0, order.windowCrates || 0, order.trackCrates || 0);

    let oldShipping, oldShippingLabel;
    if (order.actualShipping != null) {
      oldShipping = order.actualShipping;
      oldShippingLabel = 'printed on document';
    } else {
      oldShipping = legacyShipping(order);
      oldShippingLabel = 'old formula, computed (not printed on document)';
      log(`No printed shipping charge found — legacy formula computed instead: ${usd(oldShipping)}`);
    }

    let oldCrating, oldCratingLabel;
    if (order.actualCrating != null) {
      oldCrating = order.actualCrating;
      oldCratingLabel = 'printed on document';
      if (Math.abs(order.actualCrating - newCrating) > 1) {
        log(`Note: computed crating (${usd(newCrating)}) differs from printed crating (${usd(order.actualCrating)}).`);
      }
    } else {
      oldCrating = newCrating;
      oldCratingLabel = 'crating formula unchanged — same as new';
    }

    return {
      newShipping: shipping, newCrating, oldShipping, oldCrating, oldShippingLabel, oldCratingLabel,
      doorCrates: order.doorCrates || 0, windowCrates: order.windowCrates || 0, trackCrates: order.trackCrates || 0,
      crateSize: order.crateSize || null,
      mode,
      shipModeShort: MODE_LABELS[mode].short,
      shipMode: MODE_LABELS[mode].full,
    };
  }

  return {
    FORMULA_VERSION, RATES, STATE_DISTANCE, CANADA_DISTANCE, MODE_LABELS,
    resolveRegion, taper, ltlBand, ltlPrice, flatbedPrice, dedicatedPrice, islandPrice, canadaSurcharge,
    crateSizeFromPanel, cratesForLine, crateCost, isOversizeUnit,
    determineShipMode, shippingPrice, legacyFd, legacyShippingCalc, legacyShipping, computeResult,
  };
});
