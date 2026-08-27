export {
  withTenant,
  withPlatform,
  configureDatabase,
  closeDatabase,
  sql,
  type Database,
  type TenantContext,
  type PlatformContext,
  type ActorType,
} from './client.js';
export * as schema from './schema/index.js';
export { migrate } from './migrate.js';
