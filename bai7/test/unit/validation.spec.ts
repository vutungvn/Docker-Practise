import { validateProductInput } from '../../src/validation';

describe('validateProductInput', () => {
  it('accepts a valid product, trims the name and defaults stock to 0', () => {
    expect(validateProductInput({ name: '  Giay the thao ', price: 450000 })).toEqual({
      ok: true,
      value: { name: 'Giay the thao', price: 450000, stock: 0 },
    });
  });

  it('keeps an explicit stock', () => {
    const result = validateProductInput({ name: 'Ao', price: 1000, stock: 7 });
    expect(result.ok && result.value.stock).toBe(7);
  });

  it('rejects a missing name', () => {
    const result = validateProductInput({ price: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('name is required');
  });

  it.each([-1, 10.5, '1000', undefined])('rejects invalid price %p', (price) => {
    const result = validateProductInput({ name: 'Ao', price });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('price must be a non-negative integer (VND)');
  });

  it('rejects a negative stock', () => {
    const result = validateProductInput({ name: 'Ao', price: 1, stock: -2 });
    expect(result.ok).toBe(false);
  });
});
