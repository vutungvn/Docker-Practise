// DEMO for scenario 2 (README): a feature merged without tests.
//   cp demo/untested-promotion.ts src/promotion.ts   -> the "3 · Test gate" fails on the coverage threshold
// It is deliberately kept outside src/ so it never affects the real build.

export interface CartLine {
  sku: string;
  price: number;
  quantity: number;
}

export type Promotion =
  | { kind: 'percent'; value: number }
  | { kind: 'fixed'; value: number }
  | { kind: 'buy-x-get-y'; sku: string; buy: number; free: number }
  | { kind: 'free-shipping'; minimum: number };

export function subtotal(lines: CartLine[]): number {
  let sum = 0;
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    sum += line.price * line.quantity;
  }
  return sum;
}

export function applyPromotion(lines: CartLine[], promotion: Promotion, shipping: number) {
  const base = subtotal(lines);
  let discount = 0;
  let shippingFee = shipping;

  switch (promotion.kind) {
    case 'percent':
      if (promotion.value <= 0 || promotion.value > 50) throw new Error('percent must be in (0, 50]');
      discount = Math.round((base * promotion.value) / 100);
      break;
    case 'fixed':
      if (promotion.value < 0) throw new Error('fixed discount cannot be negative');
      discount = Math.min(promotion.value, base);
      break;
    case 'buy-x-get-y': {
      const line = lines.find((l) => l.sku === promotion.sku);
      if (!line) break;
      const groups = Math.floor(line.quantity / (promotion.buy + promotion.free));
      discount = groups * promotion.free * line.price;
      break;
    }
    case 'free-shipping':
      if (base >= promotion.minimum) shippingFee = 0;
      break;
  }

  const total = Math.max(0, base - discount) + shippingFee;
  return { subtotal: base, discount, shipping: shippingFee, total };
}

export function bestPromotion(lines: CartLine[], promotions: Promotion[], shipping: number) {
  let best: { promotion: Promotion; total: number } | undefined;
  for (const promotion of promotions) {
    try {
      const { total } = applyPromotion(lines, promotion, shipping);
      if (!best || total < best.total) best = { promotion, total };
    } catch {
      // an invalid promotion is skipped, not fatal
    }
  }
  return best;
}
