// PM2 process manager config — keeps the bridge running 24/7 and restarts it
// automatically if it crashes or WhatsApp drops the connection.
//
//   npm install -g pm2
//   pm2 start ecosystem.config.js
//   pm2 logs tilapiya-whatsapp-bridge   # watch it / see the pairing code on first run
//   pm2 save && pm2 startup             # auto-start on computer reboot
module.exports = {
  apps: [
    {
      name: "tilapiya-whatsapp-bridge",
      script: "index.js",
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      time: true,
    },
  ],
};
