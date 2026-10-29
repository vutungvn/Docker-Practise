export interface ProductInput {
  name: string;
  price: number;
}

export type ValidationResult =
  | { ok: true; value: ProductInput }
  | { ok: false; errors: string[] };

export function validateProductInput(body: unknown): ValidationResult {
  const errors: string[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) errors.push('name is required');
  else if (name.length > 100) errors.push('name must be at most 100 characters');

  const price = input.price;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) {
    errors.push('price must be a non-negative integer (VND)');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, price: price as number } };
}
