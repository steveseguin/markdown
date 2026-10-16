// Dependency-free actual-source regressions. No network or browser is used.
// Run: node --test tests/convert-url.test.cjs
// Compare another source: MARKDOWN_SOURCE=/path/to/index.html node --test tests/convert-url.test.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const sourcePath = process.env.MARKDOWN_SOURCE || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(sourcePath, 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(Boolean).join('\n');

function setup(input) {
    const requests = [];
    const elements = { input: { value: input }, preview: {}, sharable: {} };
    const context = vm.createContext({
        document: {
            getElementById: id => elements[id],
            addEventListener() {},
        },
        MutationObserver: class { observe() {} },
        fetch: url => {
            requests.push(url);
            // Keep the response pending: this suite tests request construction only.
            return new Promise(() => {});
        },
    });
    vm.runInContext(script, context);
    return { context, requests };
}

const cases = [
    ['plain Gist', 'https://gist.github.com/alice/123abc', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['Gist with trailing slash', 'https://gist.github.com/alice/123abc/', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['Gist file fragment', 'https://gist.github.com/alice/123abc#file-readme-md', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['Gist query', 'https://gist.github.com/alice/123abc?permalink=1', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['Gist query and fragment', 'https://gist.github.com/alice/123abc?permalink=1#file-readme-md', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['real-world Gist fragment shape', 'https://gist.github.com/vdelacou/58484f1c11af70aaa457f4e5c289e893#file-readme-md', 'https://gist.githubusercontent.com/vdelacou/58484f1c11af70aaa457f4e5c289e893/raw'],
    ['hyphenated username and numeric legacy ID', 'https://gist.github.com/user-name/11048875#file-my-readme-md-L5', 'https://gist.githubusercontent.com/user-name/11048875/raw'],
    ['raw Gist unchanged', 'https://gist.githubusercontent.com/alice/123abc/raw', 'https://gist.githubusercontent.com/alice/123abc/raw'],
    ['named raw file unchanged', 'https://gist.githubusercontent.com/user-name/11048875/raw/README%20notes.md', 'https://gist.githubusercontent.com/user-name/11048875/raw/README%20notes.md'],
    ['repository blob', 'https://github.com/alice/repo/blob/main/README.md', 'https://raw.githubusercontent.com/alice/repo/main/README.md'],
    ['external URL unchanged', 'https://example.test/doc.md?x=1#heading', 'https://example.test/doc.md?x=1#heading'],
];

for (const [name, input, expected] of cases) {
    test(name, () => {
        const { context, requests } = setup(input);
        context.generate();
        assert.equal(requests.length, 1);
        const actual = new URL(requests[0]);
        const target = new URL(expected);
        assert.equal(actual.pathname, target.pathname, 'generate() must request the raw-content path');
        assert.equal(requests[0], expected);
        assert.equal(context.convertUrl(input), expected);
    });
}
