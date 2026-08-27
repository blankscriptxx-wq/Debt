/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: [
    '@solvenda/ui', '@solvenda/core', '@solvenda/db', '@solvenda/auth',
    '@solvenda/audit', '@solvenda/comms',
  ],
  serverExternalPackages: ['pg'],
  webpack(config) {
    // The packages use NodeNext-style `./thing.js` specifiers that resolve to
    // `.ts` source.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
