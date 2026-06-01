/**
 * Mirror of server's `mayaspace/src/common/access/permissions.ts`.
 * Bit values MUST stay in sync with the server — the server's
 * `effective_permissions` field in listForUser responses is interpreted
 * with these constants.
 */
export const READ = 1;
export const UPDATE = 2;
export const CREATE = 4;
export const DELETE = 8;

/** R|U|C|D — Phase 1 admin UI's full member preset. */
export const ALL_RUCD = READ | UPDATE | CREATE | DELETE;

export function can(perms: number, bit: number): boolean {
  return (perms & bit) === bit;
}
