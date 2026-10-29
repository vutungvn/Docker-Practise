export interface ProductInput {
  name: string;
  price: number;
  stock: number;
}

export type ValidationResult = { ok: true; value: ProductInput } | { ok: false; errors: string[] };

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function validateProductInput(body: unknown): ValidationResult {
  const errors: string[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) errors.push('name is required');
  else if (name.length > 100) errors.push('name must be at most 100 characters');

  if (!isNonNegativeInteger(input.price)) errors.push('price must be a non-negative integer (VND)');

  const stock = input.stock ?? 0;
  if (!isNonNegativeInteger(stock)) errors.push('stock must be a non-negative integer');

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { name, price: input.price as number, stock: stock as number } };
}
