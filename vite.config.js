import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function apiDevPlugin() {
  return {
    name: 'api-dev-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url.startsWith('/api/game')) {
          try {
            let bodyChunks = [];
            req.on('data', chunk => bodyChunks.push(chunk));
            req.on('end', async () => {
              const rawBody = Buffer.concat(bodyChunks).toString();
              let body = {};
              if (rawBody) {
                try { body = JSON.parse(rawBody); } catch (e) {}
              }
              
              // Dynamically import the api handler module
              const { default: handler } = await server.ssrLoadModule('/api/game.js');
              
              const fakeRes = {
                status(code) {
                  res.statusCode = code;
                  return this;
                },
                json(data) {
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify(data));
                  return this;
                },
                send(msg) {
                  res.end(msg);
                  return this;
                }
              };
              
              const fakeReq = {
                method: req.method,
                body: body,
                headers: req.headers
              };
              
              await handler(fakeReq, fakeRes);
            });
          } catch (err) {
            console.error('Dev API Error:', err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), apiDevPlugin()],
});
