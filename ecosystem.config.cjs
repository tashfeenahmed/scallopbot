/**
 * PM2 Ecosystem Configuration for ScallopBot
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --env production
 *
 * IMPORTANT: Start with 'dist/cli.js start', NOT 'dist/index.js'
 * The index.js is just exports, cli.js is the actual entry point.
 */

module.exports = {
  apps: [
    {
      name: 'scallopbot',
      script: 'dist/cli.js',
      args: 'start',
      cwd: '/opt/scallopbot',

      // Restart behavior
      restart_delay: 5000,        // Wait 5s between restarts (prevents Telegram conflicts)
      max_restarts: 10,           // Max restarts before stopping
      min_uptime: 10000,          // Consider started after 10s uptime

      // Resource limits (suitable for 4GB RAM servers)
      max_memory_restart: '500M', // Restart if memory exceeds 500MB

      // Logging
      error_file: '/var/log/scallopbot/error.log',
      out_file: '/var/log/scallopbot/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // Graceful shutdown
      kill_timeout: 5000,         // Wait 5s for graceful shutdown
      listen_timeout: 10000,      // Wait 10s for app to be ready

      // Don't watch in production
      watch: false,
    },
  ],
};
