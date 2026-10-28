import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
// server/dist/index.js -> client/dist
const staticDir = process.env.STATIC_DIR ?? resolve(here, '../../client/dist');
const port = Number(process.env.PORT) || 3000;

const { httpServer } = createApp({ staticDir });
httpServer.listen(port, () => {
  console.log(`🐱 Batalha dos Gatinhos rodando na porta ${port}`);
});
