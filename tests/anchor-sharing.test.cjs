// Offline source regression checks. DOM, fetch, and Markdown parsing use inert fixtures.
// Run: node tests/anchor-sharing.test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || __dirname + '/../index.html', 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).filter(Boolean).join('\n');
new vm.Script(script);

function setup(initial = 'https://markdown.invite.cam/') {
    let current = new URL(initial);
    let observer;
    const elements = new Map();
    const requests = [];
    const scrolls = [];
    const listeners = {};
    const errors = [];
    class Element {
        constructor(id = '', text = '') { this.id = id; this.value = ''; this.textContent = text; this.style = {}; this.listeners = {}; this.children = []; }
        set innerHTML(value) {
            this._html = value;
            if (this.id === 'preview') {
                for (const [id, el] of elements) if (el.heading) elements.delete(id);
                this.headers = [...value.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(x => {const e = new Element('', x[2]); e.heading = true; return e;});
                if (observer?.target === this && observer.active) queueMicrotask(() => observer.active && observer.callback([{type:'childList', addedNodes: this.headers}]));
            }
            if (this.tagName === 'textarea') this.value = value.replace(/&amp;/g, '&');
        }
        get innerHTML() { return this._html || ''; }
        insertBefore(child) { this.children.unshift(child); if (this.id) elements.set(this.id, this); }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        scrollIntoView() { scrolls.push(this.id); }
        select() {}
    }
    for (const id of ['input', 'preview', 'sharable', 'full-interface', 'content-only-mode']) elements.set(id, new Element(id));
    const document = {
        title: 'Sharable Markdown to HTML Viewer',
        getElementById: id => elements.get(id),
        querySelectorAll: () => elements.get('preview').headers || [],
        createElement: tag => { const e = new Element(); e.tagName = tag; return e; },
        addEventListener: (name, fn) => {listeners[name] = fn;},
        execCommand() {},
    };
    const window = {get location() {return current;}};
    const context = vm.createContext({
        document, window, URLSearchParams,
        history: { pushState: (_, __, url) => {current = new URL(url, current);}},
        fetch: url => new Promise((resolve, reject) => requests.push({url, resolve: text => resolve({ok:true, text: () => Promise.resolve(text)}), fail: () => reject(new Error('fixture failure'))})),
        marked: {parse: text => text},
        navigator: {clipboard: {writeText: () => Promise.resolve()}},
        alert() {},
        console: {error: (...args) => errors.push(args)},
        MutationObserver: class {constructor(callback) {observer=this; this.callback=callback; this.active=true;} observe(target) {this.target=target;} disconnect() {this.active=false;}},
    });
    vm.runInContext(script, context);
    return {context, elements, requests, scrolls, listeners, document, errors, get url() {return current;}};
}
const settle = async () => {for(let i=0;i<8;i++) await Promise.resolve();};
const fixture = '<h1>Document</h1><p>Intro</p><h2>Target</h2>';
const results = [];
async function check(name, fn) {try {await fn(); results.push({name, result:'PASS'});} catch(e) {results.push({name,result:'FAIL', message:e.message});}}
(async () => {
    await check('Plain shared document loads and enters content-only mode', async () => {
        const t=setup('https://markdown.invite.cam/?url=https%3A%2F%2Fexample.com%2Fdoc.md'); t.listeners.DOMContentLoaded();
        assert.equal(t.requests[0].url,'https://example.com/doc.md'); t.requests[0].resolve(fixture); await settle();
        assert.equal(t.elements.get('full-interface').style.display,'none'); assert.equal(t.elements.get('preview').innerHTML,fixture);
        assert.equal(t.document.title,'Document - Markdown Viewer'); assert.equal(t.errors.length,0);
    });
    await check('Incoming shared section remains in URL after content loads', async () => {
        const t=setup('https://markdown.invite.cam/?url=https%3A%2F%2Fexample.com%2Fdoc.md#section-1'); t.listeners.DOMContentLoaded();
        t.requests[0].resolve(fixture); await settle(); assert.equal(t.url.hash,'#section-1');
    });
    await check('Incoming shared section scrolls to its heading', async () => {
        const t=setup('https://markdown.invite.cam/?url=https%3A%2F%2Fexample.com%2Fdoc.md#section-1'); t.listeners.DOMContentLoaded();
        t.requests[0].resolve(fixture); await settle(); assert.ok(t.scrolls.includes('section-1'), 'Expected target section scroll, observed: '+JSON.stringify(t.scrolls));
    });
    await check('Clicking heading creates section share link and scrolls', async () => {
        const t=setup(); t.elements.get('input').value='https://example.com/doc.md'; t.context.generate(); t.requests[0].resolve(fixture); await settle();
        t.elements.get('section-1').children[0].listeners.click({preventDefault(){}});
        assert.equal(t.url.hash,'#section-1'); assert.ok(t.scrolls.includes('section-1'));
    });
    await check('Generated section link works when opened by recipient', async () => {
        const sender=setup(); sender.elements.get('input').value='https://example.com/doc.md'; sender.context.generate(); sender.requests[0].resolve(fixture); await settle();
        sender.elements.get('section-1').children[0].listeners.click({preventDefault(){}});
        const recipient=setup(sender.url.href); recipient.listeners.DOMContentLoaded(); recipient.requests[0].resolve(fixture); await settle();
        assert.equal(recipient.url.hash,'#section-1'); assert.ok(recipient.scrolls.includes('section-1'));
    });
    await check('Unrelated fragments are not copied into generated share links', async () => {
        for (const hash of ['#t=30','#unrelated','#section-invalid','#section-1&autoplay=1']) {
            const t=setup('https://markdown.invite.cam/?url=https%3A%2F%2Fexample.com%2Fdoc.md'+hash); t.listeners.DOMContentLoaded();
            t.requests[0].resolve(fixture); await settle(); assert.equal(t.url.hash,'');
        }
    });
    await check('Generating another document clears the previous section', async () => {
        const t=setup(); t.elements.get('input').value='https://example.com/doc.md'; t.context.generate(); t.requests[0].resolve(fixture); await settle();
        t.elements.get('section-1').children[0].listeners.click({preventDefault(){}});
        t.elements.get('input').value='https://example.com/other.md'; t.context.generate(); t.requests[1].resolve('<h1>Other document</h1>'); await settle();
        assert.equal(t.url.hash,''); assert.equal(t.url.searchParams.get('url'),'https://example.com/other.md');
    });
    await check('Empty input is rejected without fetching', async () => {
        const t=setup(); t.context.generate(); assert.equal(t.requests.length,0); assert.match(t.elements.get('preview').innerHTML,/Please enter a valid URL/);
    });
    await check('Failed fetch is surfaced as error', async () => {
        const t=setup(); t.elements.get('input').value='https://example.com/missing.md';t.context.generate();t.requests[0].fail();await settle();
        assert.match(t.elements.get('preview').innerHTML,/Error loading/);assert.equal(t.errors.length,1);
    });
    await check('URL conversion preserves normal raw and GitHub forms', async () => {
        const t=setup(); assert.equal(t.context.convertUrl('https://gist.github.com/alice/123abc'),'https://gist.githubusercontent.com/alice/123abc/raw');
        assert.equal(t.context.convertUrl('https://github.com/alice/repo/blob/main/README.md'),'https://raw.githubusercontent.com/alice/repo/main/README.md');
        assert.equal(t.context.convertUrl('https://example.com/doc.md'),'https://example.com/doc.md');
    });
    console.log(JSON.stringify({source:process.argv[2] || __dirname + '/../index.html', results},null,2));
    process.exitCode=results.some(r=>r.result==='FAIL')?1:0;
})();
