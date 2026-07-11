import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedRefundAmount, isSlipOverstated } from "./check-credit-slip-voucher.js";

test("full refund with no voucher matches line total", () => {
  const lines = [{ qty_ordered: 2, qty_refunded: 2, line_total_tax_incl: 100.00 }];
  assert.equal(expectedRefundAmount(lines, 0, 100.00), 100.00);
});

test("full refund with voucher prorates the discount", () => {
  // order total 100, a 10 voucher was applied, so a full refund should be 90
  const lines = [{ qty_ordered: 1, qty_refunded: 1, line_total_tax_incl: 100.00 }];
  assert.equal(expectedRefundAmount(lines, 10.00, 100.00), 90.00);
});

test("partial refund prorates both quantity and voucher", () => {
  // 2 of 4 units refunded on a 200 line, with a 20 voucher on a 200 order
  const lines = [{ qty_ordered: 4, qty_refunded: 2, line_total_tax_incl: 200.00 }];
  assert.equal(expectedRefundAmount(lines, 20.00, 200.00), 90.00);
});

test("zero qty ordered line contributes nothing", () => {
  const lines = [{ qty_ordered: 0, qty_refunded: 0, line_total_tax_incl: 50.00 }];
  assert.equal(expectedRefundAmount(lines, 0, 50.00), 0.00);
});

test("zero products total gives zero discount ratio", () => {
  const lines = [{ qty_ordered: 1, qty_refunded: 1, line_total_tax_incl: 0.00 }];
  assert.equal(expectedRefundAmount(lines, 5.00, 0), 0.00);
});

test("shipping refund is added after the discount", () => {
  const lines = [{ qty_ordered: 1, qty_refunded: 1, line_total_tax_incl: 100.00 }];
  assert.equal(expectedRefundAmount(lines, 10.00, 100.00, 5.00), 95.00);
});

test("multiple lines prorate independently", () => {
  const lines = [
    { qty_ordered: 2, qty_refunded: 1, line_total_tax_incl: 100.00 },
    { qty_ordered: 1, qty_refunded: 1, line_total_tax_incl: 100.00 },
  ];
  // gross prorated = 50 + 100 = 150, order total before discount = 200, voucher = 20
  // discount_ratio = 0.10, expected = 150 * 0.90 = 135.00
  assert.equal(expectedRefundAmount(lines, 20.00, 200.00), 135.00);
});

test("slip matching expected is not overstated", () => {
  assert.equal(isSlipOverstated(90.00, 90.00), false);
});

test("slip within tolerance is not overstated", () => {
  assert.equal(isSlipOverstated(90.01, 90.00), false);
});

test("slip ignoring voucher is overstated", () => {
  // slip totaled the gross line instead of the net amount after the voucher
  assert.equal(isSlipOverstated(100.00, 90.00), true);
});

test("slip undercharged is not flagged as overstated", () => {
  assert.equal(isSlipOverstated(80.00, 90.00), false);
});

test("custom tolerance is respected", () => {
  assert.equal(isSlipOverstated(90.03, 90.00, 0.05), false);
});
