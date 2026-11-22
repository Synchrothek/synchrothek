/**
 * Übernimmt die Protokolldefinition aus dem Server-Repo (Referenz) in die Extension.
 *   npm run sync-protocol                      # erwartet ../synchrothek-server
 *   SYNCHROTHEK_SERVER_DIR=/pfad npm run sync-protocol
 *   npm run sync-protocol -- --check           # nur prüfen, ob beide gleich sind
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.SYNCHROTHEK_SERVER_DIR ?? path.join(root, '..', 'synchrothek-server'));
const source = path.join(serverDir, 'src', 'protocol.ts');
const target = path.join(root, 'src', 'lib', 'protocol.ts');

const HEADER = '// Automatisch übernommen aus synchrothek-server/src/protocol.ts – nicht hier bearbeiten,\n// sondern im Server-Repo ändern und `npm run sync-protocol` ausführen.\n\n';
const expected = HEADER + readFileSync(source, 'utf8');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== expected) {
    console.error('src/lib/protocol.ts weicht vom Server ab – bitte `npm run sync-protocol` ausführen.');
    process.exit(1);
  }
  console.log('Protokoll ist aktuell.');
} else {
  writeFileSync(target, expected);
  console.log(`Protokoll übernommen aus ${source}`);
}
