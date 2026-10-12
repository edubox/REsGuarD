module.exports = {
  apps: [
    {
      name: 'resguard',
      script: 'src/server.js',
      cwd: __dirname,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
