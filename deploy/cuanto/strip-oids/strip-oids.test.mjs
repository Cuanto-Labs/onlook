import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripSource } from './strip-oids.mjs';

test('removes data-oid attributes in all quote styles', () => {
    const src = `<div data-oid="a1b2" className="x"><p data-oid='zz'>hi</p><span data-oid={"q"} /></div>`;
    assert.equal(stripSource(src), `<div className="x"><p>hi</p><span /></div>`);
});

test('removes injected preload Script and its now-unused import', () => {
    const src = [
        "import Script from 'next/script';",
        "import './globals.css';",
        'export default function RootLayout({ children }) {',
        '    return (',
        '        <html lang="en">',
        '            <body>',
        '                <Script src="https://cdn.jsdelivr.net/x/onlook-preload-script.js" strategy="afterInteractive" type="module" id="onlook-preload-script"></Script>',
        '                {children}',
        '            </body>',
        '        </html>',
        '    );',
        '}',
    ].join('\n');
    const out = stripSource(src);
    assert.ok(!out.includes('onlook-preload-script'));
    assert.ok(!out.includes("from 'next/script'"));
    assert.ok(out.includes('{children}'));
});

test('keeps next/script import when another Script remains', () => {
    const src = [
        "import Script from 'next/script';",
        '<body><Script src="/analytics.js" /><Script id="onlook-preload-script" src="/onlook-preload-script.js" /></body>',
    ].join('\n');
    const out = stripSource(src);
    assert.ok(out.includes("import Script from 'next/script';"));
    assert.ok(out.includes('/analytics.js'));
    assert.ok(!out.includes('onlook-preload-script'));
});

test('leaves clean source untouched', () => {
    const src = `const a = <div className="data-oid">ok</div>;`;
    assert.equal(stripSource(src), src);
});
