/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than built output, so
  // Next compiles them alongside the app.
  transpilePackages: [
    '@solvenda/ui', '@solvenda/core', '@solvenda/db', '@solvenda/auth',
    '@solvenda/audit', '@solvenda/ai', '@solvenda/workflow', '@solvenda/comms',
  ],
  // pg is server-only; keep it out of the client bundle entirely.
  serverExternalPackages: ['pg'],
  webpack(config) {
    // The packages use NodeNext-style `./thing.js` specifiers that resolve to
    // `.ts` source. Without this, webpack looks for files that only exist after
    // a build step the workspace deliberately does not have in development.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
