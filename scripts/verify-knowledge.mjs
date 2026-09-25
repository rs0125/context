import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import matter from 'gray-matter';

const hash = value => createHash('sha256').update(value).digest('hex');

async function main() {
  const { values } = parseArgs({ options: {
    base: { type: 'string', default: 'http://127.0.0.1:3100' },
    source: { type: 'string', default: '.local/knowledge-import' },
    'key-file': { type: 'string', default: '.local/keys/local-trial.json' },
  } });
  const base = new URL(values.base);
  assert(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'INVALID_ORIGIN');
  assert(base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'HTTPS_REQUIRED');
  const { apiKey } = JSON.parse(await readFile(values['key-file'], 'utf8'));
  assert(typeof apiKey === 'string' && /^wog_ctx_[A-Za-z0-9_-]{43}$/.test(apiKey), 'INVALID_KEY_FILE');
  const files = (await readdir(values.source, { withFileTypes: true })).filter(file => file.isFile() && file.name.endsWith('.md'));
  assert(files.length > 0 && files.length <= 500, 'INVALID_IMPORT_SIZE');
  const documents = await Promise.all(files.map(async file => {
    const document = matter(await readFile(path.join(values.source, file.name), 'utf8'));
    assert(typeof document.data.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.data.id), 'INVALID_SOURCE_ID');
    return { ...document.data, body: document.content.trim() };
  }));
  let reads = 0;
  async function read(route, authenticated = true) {
    reads++;
    const response = await fetch(new URL(route, base), {
      method: 'GET', headers: authenticated ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    assert(!text.includes(apiKey), 'CREDENTIAL_ECHO');
    return { status: response.status, body: JSON.parse(text) };
  }
  const context = await read('/api/v1/context');
  assert.equal(context.status, 200, 'CONTEXT_UNAVAILABLE');
  const scopes = context.body.data.scopes;
  const reviewed = documents.filter(page => page.status === 'reviewed' && page.scopes.every(scope => scopes.includes(scope)));
  const hidden = documents.filter(page => !reviewed.includes(page));
  const listed = [];
  let cursor;
  const seenCursors = new Set();
  do {
    assert(seenCursors.size < 100, 'INDEX_PAGE_BUDGET');
    const response = await read('/api/v1/wiki/pages?limit=10' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(response.status, 200, 'INDEX_UNAVAILABLE');
    listed.push(...response.body.data.items);
    cursor = response.body.data.nextCursor;
    if (cursor) { assert(!seenCursors.has(cursor), 'REPEATED_CURSOR'); seenCursors.add(cursor); }
  } while (cursor);
  for (const page of reviewed) assert(listed.some(entry => entry.id === page.id), 'REVIEWED_PAGE_MISSING');
  for (const page of hidden) assert(!listed.some(entry => entry.id === page.id), 'HIDDEN_PAGE_LISTED');
  for (const page of documents) {
    const result = await read(`/api/v1/wiki/pages/${page.id}`);
    if (hidden.includes(page)) assert.equal(result.status, 404, 'HIDDEN_PAGE_READABLE');
    else {
      assert.equal(result.status, 200, 'PAGE_UNAVAILABLE');
      assert.equal(hash(result.body.data.body), hash(page.body), 'PAGE_CONTENT_MISMATCH');
      assert.equal(hash(result.body.data.title), hash(page.title), 'PAGE_TITLE_MISMATCH');
      assert.equal(hash(result.body.data.summary), hash(page.summary), 'PAGE_SUMMARY_MISMATCH');
      assert.equal(result.body.data.updatedAt, page.updatedAt, 'PAGE_DATE_MISMATCH');
    }
  }
  const search = await read('/api/v1/wiki/search?q=warehouse&limit=10');
  assert.equal(search.status, 200, 'SEARCH_UNAVAILABLE');
  assert(search.body.data.items.length > 0, 'SEARCH_EMPTY');
  assert(search.body.data.items.every(entry => !hidden.some(page => page.id === entry.id) && !('body' in entry)), 'SEARCH_DISCLOSURE');
  assert.equal((await read(`/api/v1/wiki/pages/${reviewed[0].id}`, false)).status, 401, 'ANONYMOUS_ACCESS');
  console.log(JSON.stringify({ result: 'passed', reviewed_pages_verified: reviewed.length, hidden_pages_verified: hidden.length, http_reads: reads }));
}

main().catch(error => {
  const message = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'KNOWLEDGE_VERIFICATION_UNAVAILABLE';
  console.error(JSON.stringify({ result: 'failed', error: message }));
  process.exitCode = 1;
});
