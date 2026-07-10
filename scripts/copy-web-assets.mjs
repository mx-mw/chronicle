import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('src/web/public');
const destination = path.resolve('dist/web/public');

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
