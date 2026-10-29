import { validateProductInput } from '../../src/validation';

describe('validateProductInput', () => {
  it('accepts a valid product and trims the name', () => {
    expect(validateProductInput({ name: '  Giay the thao ', price: 450000 })).toEqual({
      ok: true,
      value: { name: 'Giay the thao', price: 450000 },
    });
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

  it('rejects a non-object body', () => {
    expect(validateProductInput(null).ok).toBe(false);
  });
});
