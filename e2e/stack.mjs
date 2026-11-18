// Boots a private Transcribe for the end-to-end tests: its own port and temp data, nothing shared with a running service.
// Default: stand-ins for Whisper and the language model (fast, deterministic, runs anywhere).
// E2E_REAL=1: the real models, as configured on this machine.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-e2e-'));
export const PORT = 3115, MODEL_PORT = 3116;
Object.assign(process.env, {
  ORIGIN: `http://127.0.0.1:${PORT}`, DONORS_FILE: path.join(dir, 'donors.json'), STATS_FILE: path.join(dir, 'stats.json'),
  TMP_DIR: path.join(dir, 'uploads'), ADMIN_KEY: 'e2e-admin', BMC_WEBHOOK_SECRET: 'e2e-secret',
});
if (!process.env.FFMPEG_BIN && !fs.existsSync('/opt/homebrew/bin/ffmpeg')) process.env.FFMPEG_BIN = 'ffmpeg';   // Linux CI: from PATH

if (!process.env.E2E_REAL) {
  Object.assign(process.env, { ENGINE: '', WHISPER_ARGS: '', WHISPER_BIN: path.join(here, 'fake-whisper.mjs'), OLLAMA_URL: `http://127.0.0.1:${MODEL_PORT}` });
  // Stand-in for Ollama's /api/chat. Cleanup: the same words, punctuated. Notes and summary: fixed text in the transcript's language.
  http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const [system, user] = JSON.parse(body).messages.map(m => m.content);
      const es = /\b(esta|una|prueba|servicio|español)\b/i.test(user);
      const content = system.startsWith('You fix the punctuation') ? user[0].toUpperCase() + user.slice(1) + (/[.?!]$/.test(user) ? '' : '.')
        : system.startsWith('List the key points') ? (es ? '- Nota de prueba' : '- Test note')
        : es ? 'Resumen de prueba en dos frases. Trata de una prueba del servicio.\n\n- Primer punto clave\n- Segundo punto clave'
          : 'Stand-in summary in two sentences. It is about a test of the service.\n\n- First key point\n- Second key point';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content } }));
    });
  }).listen(MODEL_PORT, '127.0.0.1');
}

const { createServer } = await import('../server.mjs');
createServer().listen(PORT, '127.0.0.1', () => console.log(`e2e stack on http://127.0.0.1:${PORT} (${process.env.E2E_REAL ? 'real models' : 'stand-ins'})`));
