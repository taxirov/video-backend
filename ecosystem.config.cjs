module.exports = {
  apps: [
    {
      name: "avto-video-backend",
      script: "src/server.js",
      env: { PORT: 4000 },
      autorestart: true
    }
  ]
};
