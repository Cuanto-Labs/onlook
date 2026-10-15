#!/usr/bin/env node
// Remove Onlook editor artifacts from a repo before opening a PR:
//   - data-oid="..." JSX attributes (added to every element Onlook touches)
//   - the <Script id="onlook-preload-script"> tag Onlook injects into the root layout,
//     plus its `next/script` import when nothing else uses <Script>
// Also reports public/onlook-preload-script.js and .onlook/ for manual removal.
// Usage: node strip-oids.mjs [--check] <repo-dir>   (--check exits 1 if anything would change)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OID_ATTR = /\s+data-oid=(?:"[^"]*"|'[^']*'|\{\s*(?:"[^"]*"|'[^']*')\s*\})/g;
const PRELOAD_SCRIPT =
    /\n?[ \t]*<Script\b(?=[^>]*\bid=(?:"onlook-preload-script"|'onlook-preload-script'|\{\s*["']onlook-preload-script["']\s*\}))[^>]*?(?:\/>|>\s*<\/Script>)/g;
const SCRIPT_IMPORT = /^import\s+Script\s+from\s+["']next\/script["'];?[ \t]*\r?\n/m;
const ARTIFACTS = ['public/onlook-preload-script.js', '.onlook'];

export function stripSource(src) {
    let out = src.replace(OID_ATTR, '');
    const before = out;
    out = out.replace(PRELOAD_SCRIPT, '');
    if (out !== before && !/<Script\b/.test(out)) {
        out = out.replace(SCRIPT_IMPORT, '');
    }
    return out;
}

function listSourceFiles(repo) {
    const out = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', '*.tsx', '*.jsx', '*.ts', '*.js'], {
        encoding: 'utf8',
    });
    return out.split('\0').filter(Boolean);
}

function main(argv) {
    const check = argv.includes('--check');
    const repo = argv.filter((a) => a !== '--check')[0];
    if (!repo || !existsSync(repo)) {
        console.error('usage: strip-oids.mjs [--check] <repo-dir>');
        return 2;
    }

    const changed = [];
    for (const rel of listSourceFiles(repo)) {
        const file = path.join(repo, rel);
        if (!existsSync(file)) continue;
        const src = readFileSync(file, 'utf8');
        const out = stripSource(src);
        if (out === src) continue;
        changed.push(rel);
        if (!check) writeFileSync(file, out);
    }
    const artifacts = ARTIFACTS.filter((p) => existsSync(path.join(repo, p)));

    for (const rel of changed) console.log(`${check ? 'would strip' : 'stripped'}: ${rel}`);
    for (const rel of artifacts) console.log(`onlook artifact, remove: trash ${path.join(repo, rel)}`);
    if (!changed.length && !artifacts.length) console.log('clean: no Onlook artifacts');
    return check && (changed.length || artifacts.length) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    process.exitCode = main(process.argv.slice(2));
}
