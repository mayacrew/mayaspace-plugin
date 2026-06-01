import { READ, UPDATE, CREATE, DELETE, ALL_RUCD, can } from './permissions';

describe('permissions bit helpers', () => {
  test('bit constants match server values', () => {
    expect(READ).toBe(1);
    expect(UPDATE).toBe(2);
    expect(CREATE).toBe(4);
    expect(DELETE).toBe(8);
    expect(ALL_RUCD).toBe(15);
  });

  test('can() returns true only when bit is set', () => {
    const perms = READ | CREATE;
    expect(can(perms, READ)).toBe(true);
    expect(can(perms, CREATE)).toBe(true);
    expect(can(perms, UPDATE)).toBe(false);
    expect(can(perms, DELETE)).toBe(false);
  });

  test('can() with 0 perms returns false for all', () => {
    expect(can(0, READ)).toBe(false);
    expect(can(0, UPDATE)).toBe(false);
    expect(can(0, CREATE)).toBe(false);
    expect(can(0, DELETE)).toBe(false);
  });

  test('can() with ALL_RUCD returns true for each bit', () => {
    expect(can(ALL_RUCD, READ)).toBe(true);
    expect(can(ALL_RUCD, UPDATE)).toBe(true);
    expect(can(ALL_RUCD, CREATE)).toBe(true);
    expect(can(ALL_RUCD, DELETE)).toBe(true);
  });
});
