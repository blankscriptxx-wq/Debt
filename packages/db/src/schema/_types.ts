import { customType } from 'drizzle-orm/pg-core';

/** Case-insensitive text, used for emails and slugs. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
