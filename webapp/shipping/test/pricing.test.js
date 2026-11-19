// Run: node --test webapp/shipping/test/pricing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pricing.js');
const S = require('../parser.js');

const cents = (v) => Math.round(v * 100) / 100;
const ltlOrder = (o) => Object.assign(
  { region: 'conus', distance: 0, totalDoors: 0, totalWindows: 0, oversize: false,
    doorCrates: 1, windowCrates: 0, trackCrates: 0, crateSize: null }, o);

// Worked examples from shipping_formula_proposal_v2.pdf ("old vs. new, LTL mode").
test('proposal v2 worked examples (LTL)', () => {
  const cases = [
    ['HWWS.66 sliding wall to Boston, MA', { distance: 2713, totalDoors: 1, oversize: true }, 3662.50],
    ['2x LTS.30 lift and slide to La Mesa, CA', { distance: 331, totalDoors: 2, oversize: true }, 2213.63],
    ['TS.77 single window to Los Angeles, CA', { distance: 270, totalWindows: 1, doorCrates: 0, windowCrates: 1 }, 1230.00],
    ['Odyssey single hinged door to Culver City, CA', { distance: 281, totalDoors: 1 }, 1330.00],
    ['Pivot door to Blanco, TX (SO #4175)', { distance: 1250, totalDoors: 1, totalWindows: 1, oversize: true }, 3012.50],
  ];
  for (const [name, o, expected] of cases) {
    const r = P.shippingPrice(ltlOrder(o));
    assert.equal(r.mode, 'ltl', name);
    assert.equal(cents(r.shipping), expected, name);
  }
});

test('LTL distance bands', () => {
  assert.equal(P.ltlBand(0), 750);
  assert.equal(P.ltlBand(150), 750);
  assert.equal(P.ltlBand(151), 1050);
  assert.equal(P.ltlBand(3000), 2650);
  assert.equal(P.ltlBand(3001), 2800);   // one partial 250-mi step
  assert.equal(P.ltlBand(3250), 2800);
  assert.equal(P.ltlBand(3251), 2950);
});

test('LTL $1,200 floor', () => {
  assert.equal(P.shippingPrice(ltlOrder({ distance: 50 })).shipping, 1200);
});

test('mode selection', () => {
  const crate = (length, height) => ({ length, height, width: 45 });
  assert.equal(P.determineShipMode(ltlOrder({ crateSize: crate(120, 101) })), 'flatbed');
  assert.equal(P.determineShipMode(ltlOrder({ crateSize: crate(281, 60) })), 'flatbed');
  assert.equal(P.determineShipMode(ltlOrder({ crateSize: crate(280, 100) })), 'ltl');
  assert.equal(P.determineShipMode(ltlOrder({ doorCrates: 6 })), 'dedicated');
  assert.equal(P.determineShipMode(ltlOrder({ totalDoors: 6, totalWindows: 6 })), 'dedicated');
  assert.equal(P.determineShipMode(ltlOrder({ doorCrates: 5, totalDoors: 11 })), 'ltl');
  // Flatbed wins over dedicated.
  assert.equal(P.determineShipMode(ltlOrder({ doorCrates: 9, crateSize: crate(300, 60) })), 'flatbed');
  assert.equal(P.determineShipMode({ region: 'hawaii' }), 'ocean');
  assert.equal(P.determineShipMode({ region: 'alaska' }), 'barge');
});

test('dedicated and flatbed pricing', () => {
  assert.equal(cents(P.dedicatedPrice(2000)), 5200);
  assert.equal(P.dedicatedPrice(100), 1600);
  assert.equal(cents(P.flatbedPrice(1000)), 3550);
  // Current behaviour: minimum applies to mileage, handling added on top.
  assert.equal(P.flatbedPrice(100), 2250);
});

test('Hawaii / Alaska scale with order size', () => {
  const hi = (o) => P.shippingPrice(Object.assign({ region: 'hawaii' }, o)).shipping;
  assert.equal(cents(hi({ totalWindows: 1 })), 5070);
  assert.equal(cents(hi({ totalDoors: 1, oversize: true })), 6264);
  assert.ok(hi({ totalDoors: 10 }) > hi({ totalWindows: 1 }));
  const ak = P.shippingPrice({ region: 'alaska', totalDoors: 1 }).shipping;
  assert.equal(cents(ak), 4580);
});

test('Canada surcharge: 25% or $400, whichever is larger', () => {
  const small = P.shippingPrice(ltlOrder({ region: 'canada', distance: 900, totalWindows: 1 }));
  assert.equal(cents(small.shipping), 1880 + 470);
  const tiny = P.shippingPrice(ltlOrder({ region: 'canada', distance: 50 }));
  assert.equal(tiny.shipping, 1200 + 400);
});

test('crating', () => {
  assert.deepEqual(P.cratesForLine('door', 9, true), { door: 2, window: 0, track: 2 });
  assert.deepEqual(P.cratesForLine('window', 11, false), { door: 0, window: 2, track: 0 });
  assert.deepEqual(P.cratesForLine('unclassified', 3, true), { door: 1, window: 0, track: 0 });
  assert.equal(P.crateCost(2, 1, 1), 480 * 3 + 300);
  assert.deepEqual(P.crateSizeFromPanel(50, 110), { length: 130, height: 70, width: 45 });
  assert.equal(P.crateSizeFromPanel(0, 110), null);
});

test('resolveRegion', () => {
  assert.deepEqual(P.resolveRegion('ma'), { region: 'conus', distance: 2713, resolved: true });
  assert.equal(P.resolveRegion('ON').region, 'canada');
  assert.equal(P.resolveRegion('HI').region, 'hawaii');
  assert.equal(P.resolveRegion('ZZ').resolved, false);
  assert.equal(P.resolveRegion('').resolved, false);
});

test('parser: sample sales order text', () => {
  const text = [
    'Sales Order 9999',
    'Ship To',
    'Jane Doe',
    '123 Main St',
    'Culver City, CA 90230',
    'Number of Doors Number of Windows',
    '1 2',
    'Project Type Residential',
    'UNIT: 1 QTY: 1 Hinged Door',
    'Frame Dimensions 40 1/2 W x 96 H',
    'Panel Dimensions 36 W x 92 3/4 H',
    'UNIT: 2 QTY: 2 Casement Window',
    'Frame Dimensions 30 W x 48 H',
    'Panel Dimensions 28 W x 46 H',
    'Crating: $960.00',
    'Est. Shipping: $471.13',
    'Grand Total $12,345.67',
  ].join('\n');
  const d = S.parseSalesOrder(text);
  assert.deepEqual(d.addr, { city: 'Culver City', state: 'CA', zip: '90230', country: 'US' });
  assert.equal(d.region, 'conus');
  assert.equal(d.totalDoors, 1);
  assert.equal(d.totalWindows, 2);
  assert.equal(d.summaryFound, true);
  assert.equal(d.lineNum, 2);
  assert.equal(d.doorCrates, 1);
  assert.equal(d.windowCrates, 1);
  assert.equal(d.maxPanelWidth, 36);
  assert.equal(d.maxPanelHeight, 92.75);
  assert.deepEqual(d.crateSize, { length: 112.75, height: 56, width: 45 });
  assert.equal(d.oversize, false);
  assert.equal(d.actualCrating, 960);
  assert.equal(d.actualShipping, 471.13);
  assert.equal(d.grandTotal, 12345.67);
  assert.equal(S.validateData(d).level, 'high');

  const r = P.computeResult(d);
  assert.equal(r.mode, 'ltl');
  assert.equal(r.oldShipping, 471.13);
  assert.equal(r.newCrating, 960);
});

test('parser: Canadian postal code and wrapped dimensions', () => {
  assert.deepEqual(S.extractShipTo('Ship To\nVancouver, BC V6B 1A1'),
    { city: 'Vancouver', state: 'BC', zip: 'V6B 1A1', country: 'CA' });
  const pair = S.extractDimPair('Frame Dimensions 58 3/32 W x 91 Glass: LowE\n11/16 H', 'Frame Dimensions');
  assert.equal(pair.w, 58 + 3 / 32);
  assert.equal(pair.h, 91 + 11 / 16);
});
