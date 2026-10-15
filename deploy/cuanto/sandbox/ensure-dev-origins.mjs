// Runs at sandbox start (cwd /app). Next dev blocks /_next/* dev resources (JS chunks, HMR) for origins other than
// localhost, and previews are served through tailscale serve on another host → the page never hydrates and the
// Onlook preload script never connects. Adds `allowedDevOrigins` to next.config.* when the project has none.
// The line is tagged `// onlook-dev-origin` so deploy/cuanto/strip-oids removes it before a PR.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const origin = process.env.ONLOOK_DEV_ORIGIN || '*.tail789fa0.ts.net';
const line = `allowedDevOrigins: [${JSON.stringify(origin)}], // onlook-dev-origin`;

export function addDevOrigin(src) {
    if (/allowedDevOrigins/.test(src)) return src;
    // `const nextConfig: NextConfig = {`, `const nextConfig = {`, `module.exports = {`, `export default {`
    const open = /((?:const\s+\w+(?:\s*:\s*[\w.]+)?|module\.exports|export\s+default)\s*=?\s*\{)[ \t]*\r?\n?/;
    if (!open.test(src)) return src;
    return src.replace(open, (_m, head) => `${head}\n  ${line}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const file = ['next.config.ts', 'next.config.mjs', 'next.config.js'].find((f) => existsSync(f));
    if (!file) process.exit(0);
    try {
        const src = readFileSync(file, 'utf8');
        const out = addDevOrigin(src);
        if (out !== src) {
            writeFileSync(file, out);
            console.log(`[onlook] added allowedDevOrigins to ${file}`);
        } else if (!/allowedDevOrigins/.test(src)) {
            console.log(`[onlook] could not add allowedDevOrigins to ${file}; previews may not hydrate`);
        }
    } catch (e) {
        console.log(`[onlook] ensure-dev-origins skipped: ${e.message}`);
    }
}
