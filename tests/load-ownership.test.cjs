// Offline actual-source checks. Fetch, DOM, and Markdown parsing use inert fixtures.
// Run: node tests/load-ownership.test.cjs [path/to/index.html]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(source, 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(Boolean).join('\n');
new vm.Script(script);

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup(initialUrl = 'https://markdown.invite.cam/') {
    let location = new URL(initialUrl);
    const requests = [], history = [], scrolls = [], errors = [], parses = [];
    const elements = new Map();
    const listeners = {};
    class Element {
        constructor(id = '') { this.id = id; this.value = ''; this.style = {}; this.children = []; this.listeners = {}; }
        get innerHTML() { return this.html || ''; }
        set innerHTML(value) {
            this.html = value;
            if (this.id === 'preview') {
                for (const [id, element] of elements) if (element.heading) elements.delete(id);
                this.headers = [...value.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(match => {
                    const heading = new Element(); heading.heading = true; heading.textContent = match[2]; return heading;
                });
            }
            if (this.tag === 'textarea') this.value = value.replace(/&amp;/g, '&');
        }
        insertBefore(child) { this.children.unshift(child); elements.set(this.id, this); }
        addEventListener(type, callback) { this.listeners[type] = callback; }
        scrollIntoView() { scrolls.push(this.id); }
        select() {}
    }
    for (const id of ['input', 'preview', 'sharable', 'full-interface', 'content-only-mode']) elements.set(id, new Element(id));
    const document = {
        title: 'Markdown Viewer',
        getElementById: id => elements.get(id),
        querySelectorAll: () => elements.get('preview').headers || [],
        createElement: tag => { const element = new Element(); element.tag = tag; return element; },
        addEventListener: (type, callback) => { listeners[type] = callback; },
        execCommand() {},
    };
    const context = vm.createContext({
        document, URLSearchParams,
        window: { get location() { return location; } },
        history: { pushState: (_, __, url) => { location = new URL(url, location); history.push(location.href); } },
        fetch: url => {
            const response = deferred(), body = deferred();
            requests.push({
                url,
                respond: (ok = true) => response.resolve({ ok, text: () => body.promise }),
                succeed: text => { response.resolve({ ok: true, text: () => body.promise }); body.resolve(text); },
                body: text => body.resolve(text),
                rejectBody: () => body.reject(new Error('fixture body failure')),
                fail: () => response.reject(new Error('fixture fetch failure')),
            });
            return response.promise;
        },
        marked: { parse: text => { parses.push(text); if (text === 'PARSE_FAILURE') throw new Error('fixture parse failure'); return text; } },
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        console: { error: (...args) => errors.push(args) },
        alert() {},
        MutationObserver: class { observe() {} disconnect() {} },
    });
    vm.runInContext(script, context);
    return {
        context, document, elements, requests, history, scrolls, errors, parses, listeners,
        get url() { return location; },
        generate: url => { elements.get('input').value = url; context.generate(); },
        get preview() { return elements.get('preview').innerHTML; },
        heading: () => elements.get('section-1').children[0].listeners.click({ preventDefault() {} }),
    };
}

const A = 'https://example.test/a.md', B = 'https://example.test/b.md';
const docA = '<h1>Document A</h1><h2>A section</h2>';
const docB = '<h1>Document B</h1><h2>B section</h2>';
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const results = [];
async function check(name, run) {
    try { await run(); results.push({ name, result: 'PASS' }); }
    catch (error) { results.push({ name, result: 'FAIL', message: error.message }); }
}

(async () => {
    await check('Single Generate renders, titles and shares the requested document', async () => {
        const t = setup(); t.generate(A); t.requests[0].succeed(docA); await settle();
        assert.equal(t.preview, docA); assert.equal(t.document.title, 'Document A - Markdown Viewer');
        assert.equal(t.url.searchParams.get('url'), A); assert.equal(t.history.length, 1); assert.equal(t.errors.length, 0);
    });
    await check('Editing input before completion does not mislabel the loaded document', async () => {
        const t = setup(); t.generate(A); t.elements.get('input').value = B; t.requests[0].succeed(docA); await settle();
        assert.equal(t.preview, docA); assert.equal(t.url.searchParams.get('url'), A);
    });
    await check('Heading sharing stays bound to displayed document after input editing', async () => {
        const t = setup(); t.generate(A); t.requests[0].succeed(docA); await settle();
        t.elements.get('input').value = B; t.heading();
        assert.equal(t.url.searchParams.get('url'), A); assert.equal(t.url.hash, '#section-1');
    });
    await check('Newer request wins when older success arrives last', async () => {
        const t = setup(); t.generate(A); t.generate(B); t.requests[1].succeed(docB); await settle();
        t.requests[0].succeed(docA); await settle();
        assert.equal(t.preview, docB); assert.equal(t.document.title, 'Document B - Markdown Viewer');
        assert.equal(t.history.length, 1); assert.deepEqual(t.parses, [docB]);
    });
    await check('Superseded success cannot render while latest request is still pending', async () => {
        const t = setup(); t.generate(A); t.generate(B); t.requests[0].succeed(docA); await settle();
        assert.equal(t.preview, ''); assert.equal(t.history.length, 0);
        t.requests[1].succeed(docB); await settle(); assert.equal(t.preview, docB);
    });
    await check('Older response body completion cannot replace newer document', async () => {
        const t = setup(); t.generate(A); t.requests[0].respond(); await settle();
        t.generate(B); t.requests[1].succeed(docB); await settle(); t.requests[0].body(docA); await settle();
        assert.equal(t.preview, docB); assert.equal(t.history.length, 1);
    });
    await check('Older fetch failure cannot erase newer successful preview', async () => {
        const t = setup(); t.generate(A); t.generate(B); t.requests[1].succeed(docB); await settle();
        t.requests[0].fail(); await settle(); assert.equal(t.preview, docB); assert.equal(t.errors.length, 0);
    });
    await check('Older body failure cannot erase newer successful preview', async () => {
        const t = setup(); t.generate(A); t.requests[0].respond(); await settle();
        t.generate(B); t.requests[1].succeed(docB); await settle(); t.requests[0].rejectBody(); await settle();
        assert.equal(t.preview, docB); assert.equal(t.errors.length, 0);
    });
    await check('Older HTTP failure cannot erase newer successful preview', async () => {
        const t = setup(); t.generate(A); t.generate(B); t.requests[1].succeed(docB); await settle();
        t.requests[0].respond(false); await settle(); assert.equal(t.preview, docB); assert.equal(t.errors.length, 0);
    });
    await check('Latest failure remains visible after an older success', async () => {
        const t = setup(); t.generate(A); t.generate(B); t.requests[1].fail(); await settle();
        t.requests[0].succeed(docA); await settle(); assert.match(t.preview, /Error loading/); assert.equal(t.history.length, 0);
    });
    await check('Empty Generate invalidates earlier pending completion', async () => {
        const t = setup(); t.generate(A); t.generate(''); t.requests[0].succeed(docA); await settle();
        assert.match(t.preview, /Please enter a valid URL/); assert.equal(t.requests.length, 1); assert.equal(t.history.length, 0);
    });
    await check('Repeated Generate for same URL still keeps newest response', async () => {
        const t = setup(); t.generate(A); t.generate(A); t.requests[1].succeed(docB); await settle();
        t.requests[0].succeed(docA); await settle(); assert.equal(t.preview, docB); assert.equal(t.url.searchParams.get('url'), A);
    });
    await check('Latest HTTP failure is reported normally', async () => {
        const t = setup(); t.generate(A); t.requests[0].respond(false); await settle();
        assert.match(t.preview, /Error loading/); assert.equal(t.errors.length, 1);
    });
    await check('Latest Markdown parser failure is reported normally', async () => {
        const t = setup(); t.generate(A); t.requests[0].succeed('PARSE_FAILURE'); await settle();
        assert.match(t.preview, /Error loading/); assert.equal(t.errors.length, 1);
    });
    await check('Raw conversion preserves original share URL and query characters', async () => {
        const t = setup(); const gist = 'https://gist.github.com/alice/123abc'; t.generate(gist);
        assert.equal(t.requests[0].url, 'https://gist.githubusercontent.com/alice/123abc/raw');
        t.requests[0].succeed(docA); await settle(); assert.equal(t.url.searchParams.get('url'), gist);
        const raw = 'https://example.test/raw.md?a=1&b=%25#part'; t.generate(raw); t.requests[1].succeed(docB); await settle();
        assert.equal(t.url.searchParams.get('url'), raw);
    });
    await check('Initial plain shared URL still loads in content-only mode', async () => {
        const t = setup('https://markdown.invite.cam/?url=' + encodeURIComponent(A)); t.listeners.DOMContentLoaded();
        t.requests[0].succeed(docA); await settle(); assert.equal(t.preview, docA);
        assert.equal(t.elements.get('full-interface').style.display, 'none'); assert.equal(t.url.searchParams.get('url'), A);
    });
    await check('Sequential successful loads switch heading links to new document', async () => {
        const t = setup(); t.generate(A); t.requests[0].succeed(docA); await settle(); t.heading();
        t.generate(B); t.requests[1].succeed(docB); await settle(); assert.equal(t.url.hash, '');
        t.elements.get('input').value = A; t.heading(); assert.equal(t.url.searchParams.get('url'), B);
    });
    console.log(JSON.stringify({ source, results, passed: results.filter(r => r.result === 'PASS').length, failed: results.filter(r => r.result === 'FAIL').length }, null, 2));
    process.exitCode = results.some(r => r.result === 'FAIL') ? 1 : 0;
})();
