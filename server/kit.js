import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KIT = process.env.WORK_DASH_KIT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const require = createRequire(import.meta.url);
export const core = (name) => require(path.join(KIT, 'core', name));
export const corePath = (name) => path.join(KIT, 'core', name);
export const view = (name) => import(pathToFileURL(path.join(KIT, 'view', name)).href);
export const installer = () => import(pathToFileURL(path.join(KIT, 'bin', 'install.js')).href);
export const { HOME } = core('paths.js');
