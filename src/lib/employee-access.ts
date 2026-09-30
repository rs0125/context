import type { PoolClient } from 'pg';

export type RosterEmployee = {
  id: number; email: string; name: string; is_active: boolean;
  dashboardAccess: boolean; adminAccess: boolean; analystAccess: boolean;
  twenty_user_id: string | null;
};

/** Analyst access is an application permission, independent of Twenty roles.
 * Always derive inherited access from the current roster, never a saved claim. */
export function hasAnalystAccess(employee: { adminAccess: unknown; analystAccess?: unknown }) {
  return employee.adminAccess === true || employee.analystAccess === true;
}

export async function readRosterEmployees(client: PoolClient, email: string) {
  return client.query<RosterEmployee>(`SELECT r.id, r.email, r.name, r.is_active,
      r."dashboardAccess", r."adminAccess", r."analystAccess", r.twenty_user_id
    FROM public."VerifiedNumber" r
    WHERE lower(r.email) = $1 LIMIT 2`, [email]);
}
