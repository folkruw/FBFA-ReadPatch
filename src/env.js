// Charge le fichier .env (s'il existe) et fixe le fuseau horaire.
// Doit être importé avant tout le reste.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Les dates saisies (« 01/11/2026 18:30 ») sont interprétées dans ce fuseau.
process.env.TZ ||= 'Europe/Paris';
