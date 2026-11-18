#!/usr/bin/env node
// Stand-in for whisper-cli in the end-to-end tests. Takes the flags the server passes, reports progress on stderr the
// way whisper.cpp does, and writes whisper.cpp-shaped JSON. It takes longer for longer audio, like the real thing,
// so a long fixture leaves time to cancel or reload mid-job.
import fs from 'node:fs';
const arg = f => process.argv[process.argv.indexOf(f) + 1];
const es = arg('-l') === 'es';   // "auto" is treated as English
const seconds = (fs.statSync(arg('-f')).size - 44) / 32000;
const lines = process.env.E2E_FAKE_BROKEN ? ['Completely wrong output.']   // lets us prove the suite fails when transcripts are wrong
  : es ? ['Hola, esta es una prueba del servicio de transcripción.', 'Debería funcionar muy bien en español.']
    : ['Hello, this is a test of the transcription service.', 'It should produce two segments with timestamps.'];
const total = Math.min(seconds * 150, 6000);
for (const p of [5, 25, 50, 75, 100]) {
  await new Promise(r => setTimeout(r, total / 5));
  process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`);
}
fs.writeFileSync(arg('-of') + '.json', JSON.stringify({ result: { language: es ? 'es' : 'en' },
  transcription: lines.map((text, i) => ({ offsets: { from: i * 3000, to: i * 3000 + 2700 }, text: ' ' + text })) }));
