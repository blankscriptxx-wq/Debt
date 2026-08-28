/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: [
    '@solvenda/ui', '@solvenda/core', '@solvenda/db', '@solvenda/auth',
    '@solvenda/audit', '@solvenda/ai', '@solvenda/integrations',
  ],
  serverExternalPackages: ['pg'],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
