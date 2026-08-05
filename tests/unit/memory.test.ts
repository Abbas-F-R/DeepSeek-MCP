import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;
// Auto-capture would call the live API; these tests exercise the merge path directly.
process.env.MEMORY_AUTOCAPTURE = '0';

const { MemoryStore } = await import('../../src/memory/MemoryStore.js');
const { formatEntry, parseEntry, readSection, writeSection } = await import('../../src/memory/format.js');
const { similarity, contradicts, sameClaim } = await import('../../src/memory/Facts.js');
const { recall, tokenize } = await import('../../src/memory/Recall.js');
const { parseFactLines } = await import('../../src/memory/Curator.js');

describe('memory format', () => {
  test('an entry round-trips through format and parse', () => {
    const entry = {
      id: 'a3f',
      text: 'Kestrel binds 0.0.0.0:6777',
      anchors: ['server/Program.cs:30', 'server/appsettings.json:45'],
      kind: 'config' as const,
      hits: 4,
      confidence: 0.9,
      date: '2026-08-05',
    };

    const parsed = parseEntry(formatEntry(entry));
    assert.deepEqual(parsed, { ...entry, supersededBy: undefined });
  });

  test('text containing @ and # is not mistaken for metadata', () => {
    const entry = {
      id: 'b7c',
      text: 'Routes use the @Controller decorator and the #region marker',
      anchors: ['src/app.ts:1'],
      kind: 'convention' as const,
      hits: 0,
      confidence: 0.6,
      date: '2026-08-05',
    };

    const parsed = parseEntry(formatEntry(entry))!;
    assert.equal(parsed.text, entry.text);
    assert.deepEqual(parsed.anchors, ['src/app.ts:1']);
    assert.equal(parsed.kind, 'convention');
  });

  test('a hand-written line without metadata still parses', () => {
    const parsed = parseEntry('- [zz1] someone typed this by hand')!;
    assert.equal(parsed.text, 'someone typed this by hand');
    assert.equal(parsed.anchors.length, 0);
    assert.ok(parsed.confidence > 0);
  });

  test('sections are read and rewritten in place', () => {
    const doc = '# Title\n\n## One\nfirst\n\n## Two\nsecond\n';
    assert.equal(readSection(doc, 'One').join('').trim(), 'first');

    const updated = writeSection(doc, 'One', 'replaced');
    assert.match(updated, /## One\nreplaced/);
    assert.match(updated, /## Two\nsecond/);
  });
});

describe('MemoryStore', () => {
  const sandboxes: Sandbox[] = [];
  const make = (preset: Parameters<typeof createSandbox>[0] = 'node-ts', extra?: Record<string, string>) => {
    const sandbox = createSandbox(preset, extra);
    sandboxes.push(sandbox);
    return sandbox;
  };

  after(() => {
    for (const sandbox of sandboxes) sandbox.cleanup();
    state.cleanup();
  });

  describe('stack detection', () => {
    test('detects a TypeScript/Express project and writes markdown, not JSON', () => {
      const sandbox = make('node-ts');
      const project = MemoryStore.for(sandbox.root).getProject();

      assert.equal(project.language, 'TypeScript');
      assert.equal(project.framework, 'Express.js');
      assert.equal(project.testFramework, 'Vitest');
      assert.equal(project.root, sandbox.root);

      assert.ok(sandbox.exists('.agent/memory/PROJECT.md'));
      assert.ok(!sandbox.exists('.agent/project.json'), 'no JSON should be written');
      assert.match(sandbox.read('.agent/memory/PROJECT.md'), /^# /);
    });

    test('detects a Python/FastAPI project', () => {
      const sandbox = make('python');
      const project = MemoryStore.for(sandbox.root).getProject();
      assert.equal(project.language, 'Python');
      assert.equal(project.framework, 'FastAPI');
    });

    test('finds every module in a monorepo whose root holds no manifest', () => {
      const sandbox = make('monorepo');
      const project = MemoryStore.for(sandbox.root).getProject();

      const dirs = project.modules.map((m) => m.dir).sort();
      assert.deepEqual(dirs, ['dashboard', 'server']);

      const dashboard = project.modules.find((m) => m.dir === 'dashboard')!;
      assert.equal(dashboard.language, 'TypeScript');
      assert.equal(dashboard.framework, 'React + Vite');
      assert.equal(dashboard.testFramework, 'Vitest');

      const server = project.modules.find((m) => m.dir === 'server')!;
      assert.equal(server.language, 'C# (.NET)');
      assert.equal(server.testFramework, 'xUnit');

      // The old detector returned nothing at all for this shape.
      assert.ok(project.language, 'rolled-up language should not be empty');
      assert.match(MemoryStore.for(sandbox.root).projectDirective(), /Modules:/);
    });

    test('nested projects of one solution collapse into a single module', () => {
      const sandbox = make('monorepo', {
        // A .NET solution with its projects one level down, as real repos ship it.
        'server/Api.sln': 'Microsoft Visual Studio Solution File\n',
        'server/src/Core/Core.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
        'server/tests/Core.Tests/Core.Tests.csproj':
          '<Project Sdk="Microsoft.NET.Sdk">\n  <PackageReference Include="xunit" />\n</Project>\n',
      });

      const project = MemoryStore.for(sandbox.root).getProject();
      const dotnet = project.modules.filter((m) => m.language === 'C# (.NET)');

      assert.equal(dotnet.length, 1, 'one solution should be one module, not one per csproj');
      assert.equal(dotnet[0].dir, 'server');
      // Detail found only in the nested test project is merged upward.
      assert.equal(dotnet[0].testFramework, 'xUnit');
    });

    test('project memory is written as readable markdown', () => {
      const sandbox = make('monorepo');
      MemoryStore.for(sandbox.root).getProject();

      const doc = sandbox.read('.agent/memory/PROJECT.md');
      assert.match(doc, /## Modules/);
      assert.match(doc, /- dashboard —/);
      assert.match(doc, /- server —/);
    });
  });

  describe('rules', () => {
    test('rules persist, deduplicate and reach the directive', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.addRule('Use Result types, never throw across module boundaries');
      store.addRule('use result types, never throw across module boundaries.');

      assert.equal(store.getRules().length, 1, 'punctuation and case should not create a second rule');
      assert.match(store.projectDirective(), /Use Result types/);
      assert.match(sandbox.read('.agent/memory/RULES.md'), /Use Result types/);
    });

    test('a rule can be removed by id', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const entry = store.addRule('Prefer composition over inheritance')!;

      assert.equal(store.removeRule(entry.id), true);
      assert.equal(store.getRules().length, 0);
      assert.equal(store.removeRule('nope'), false);
    });

    test('rules never leak between projects', () => {
      const a = make('node-ts');
      const b = make('node-ts');

      MemoryStore.for(a.root).addRule('Only in project A');

      assert.equal(MemoryStore.for(b.root).getRules().length, 0);
      assert.doesNotMatch(MemoryStore.for(b.root).projectDirective(), /project A/);
    });
  });

  describe('facts', () => {
    test('a new fact is stored with its anchors', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const report = store.rememberFacts([
        { text: 'Kestrel binds 0.0.0.0 on port 6777', anchors: ['src/server.ts:5'], kind: 'config' },
      ]);

      assert.equal(report.added.length, 1);
      assert.deepEqual(report.added[0].anchors, ['src/server.ts:5']);
      assert.match(sandbox.read('.agent/memory/FACTS.md'), /port 6777/);
    });

    test('seeing the same fact again reinforces instead of duplicating', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([{ text: 'The API is versioned by URL segment under /api/v1', kind: 'contract' }]);
      const second = store.rememberFacts([
        { text: 'The API is versioned by URL segment under /api/v1', kind: 'contract' },
      ]);

      assert.equal(second.added.length, 0);
      assert.equal(second.reinforced.length, 1);
      assert.equal(second.reinforced[0].hits, 1);
      assert.ok(second.reinforced[0].confidence > 0.6, 'confidence should rise on re-observation');
      assert.equal(store.facts.load().length, 1);
    });

    test('a changed value about the same file supersedes the old claim', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([
        { text: 'Kestrel listens on port 6777 in development', anchors: ['src/server.ts:5'], kind: 'config' },
      ]);
      const report = store.rememberFacts([
        { text: 'Kestrel listens on port 8080 in development', anchors: ['src/server.ts:5'], kind: 'config' },
      ]);

      assert.equal(report.superseded.length, 1);
      assert.equal(store.facts.load().length, 1, 'the old claim should not linger alongside the new one');
      assert.match(store.facts.load()[0].text, /8080/);

      // Retired, not destroyed.
      assert.match(sandbox.read('.agent/memory/ARCHIVE.md'), /6777/);
    });

    test('an over-long claim is rejected rather than stored', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const report = store.rememberFacts([{ text: 'x'.repeat(400), kind: 'gotcha' }]);
      assert.equal(report.added.length, 0);
      assert.equal(report.rejected.length, 1);
    });

    test('absolute anchors are stored relative to the project root', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const report = store.rememberFacts([
        { text: 'The sum helper drops the last element', anchors: [path.join(sandbox.root, 'src/math.ts') + ':4'] },
      ]);

      assert.deepEqual(report.added[0].anchors, ['src/math.ts:4']);
    });

    test('facts never leak between projects', () => {
      const a = make('node-ts');
      const b = make('node-ts');

      MemoryStore.for(a.root).rememberFacts([{ text: 'Project A uses a queue-backed outbox' }]);
      assert.equal(MemoryStore.for(b.root).facts.load().length, 0);
    });
  });

  describe('verification and forgetting', () => {
    test('a fact whose file is gone is weakened, then archived', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      sandbox.write('src/gone.ts', 'export const retry = 3;\n');
      store.rememberFacts([{ text: 'Temp module holds the retry policy', anchors: ['src/gone.ts:1'] }]);
      fs.rmSync(sandbox.path('src/gone.ts'), { force: true });

      // 0.6 -> 0.30 -> below the 0.25 floor.
      const first = store.verifyFacts();
      assert.equal(first.weakened.length, 1);

      const second = store.verifyFacts();
      assert.equal(second.archived.length, 1);
      assert.equal(store.facts.load().length, 0);
      assert.match(sandbox.read('.agent/memory/ARCHIVE.md'), /retry policy/);
    });

    test('a fact whose anchor still resolves survives untouched', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([{ text: 'The sum helper lives in the math module', anchors: ['src/math.ts:1'] }]);
      const report = store.verifyFacts();

      assert.equal(report.ok, 1);
      assert.equal(report.archived.length, 0);
      assert.equal(store.facts.load().length, 1);
    });

    test('a line-range anchor resolves like a single line', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      // Models cite ranges constantly; reading "4-6" as part of the filename
      // made every such anchor look like a deleted file.
      store.rememberFacts([{ text: 'The loop body lives here', anchors: ['src/math.ts:4-6'] }]);
      const report = store.verifyFacts();

      assert.equal(report.ok, 1);
      assert.equal(report.weakened.length, 0);
      assert.deepEqual(store.facts.load()[0].anchors, ['src/math.ts:4-6']);
    });

    test('editing the anchored line by hand marks the fact stale', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      sandbox.write('src/server.ts', 'const PORT = 6777;\nexport const start = () => PORT;\n');
      store.rememberFacts([{ text: 'The server listens on port 6777', anchors: ['src/server.ts:1'], kind: 'config' }]);
      assert.ok(store.facts.load()[0].fingerprint, 'a fingerprint is taken when the fact is recorded');

      // The file still exists and line 1 still exists — only the code changed.
      sandbox.write('src/server.ts', 'const PORT = 8080;\nexport const start = () => PORT;\n');

      const report = store.verifyFacts();
      assert.equal(report.changed.length, 1, 'an edit behind the anchor must not pass as intact');
      assert.equal(report.ok, 0);

      const stored = store.facts.load()[0];
      assert.equal(stored.stale, true);
      assert.ok(stored.confidence < 0.6, 'confidence drops but the claim is not thrown away');
    });

    test('a stale fact is served with a warning, not as established fact', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      sandbox.write('src/server.ts', 'const PORT = 6777;\n');
      store.rememberFacts([{ text: 'The server listens on port 6777', anchors: ['src/server.ts:1'], kind: 'config' }]);
      sandbox.write('src/server.ts', 'const PORT = 8080;\n');

      // No explicit verify call — the retrieval path has to catch this itself.
      const directive = store.projectDirective('what port does the server listen on');
      assert.match(directive, /STALE: this code changed since/);
    });

    test('an edit elsewhere in the file leaves an unrelated fact alone', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      sandbox.write('src/app.ts', 'const PORT = 6777;\nconst NAME = "a";\nconst OTHER = 1;\n');
      store.rememberFacts([{ text: 'The port constant is 6777', anchors: ['src/app.ts:1'], kind: 'config' }]);

      sandbox.write('src/app.ts', 'const PORT = 6777;\nconst NAME = "b";\nconst OTHER = 2;\n');

      const report = store.verifyFacts();
      assert.equal(report.changed.length, 0, 'only the anchored lines are fingerprinted');
      assert.equal(report.ok, 1);
    });

    test('re-observing a stale fact clears the warning', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      sandbox.write('src/server.ts', 'const PORT = 6777;\n');
      store.rememberFacts([{ text: 'The server listens on port 6777', anchors: ['src/server.ts:1'], kind: 'config' }]);
      sandbox.write('src/server.ts', 'const PORT = 6777; // reformatted\n');
      store.verifyFacts();
      assert.equal(store.facts.load()[0].stale, true);

      store.rememberFacts([{ text: 'The server listens on port 6777', anchors: ['src/server.ts:1'], kind: 'config' }]);
      assert.equal(store.facts.load()[0].stale, undefined, 'a fresh sighting re-proves the claim');
    });

    test('an anchor past the end of the file only weakens the fact', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([{ text: 'Something at a line that no longer exists', anchors: ['src/math.ts:9000'] }]);
      const report = store.verifyFacts();

      assert.equal(report.weakened.length, 1);
      assert.equal(report.archived.length, 0);
    });
  });

  describe('recall', () => {
    const entry = (over: Record<string, unknown> = {}) =>
      ({
        id: Math.random().toString(36).slice(2, 5),
        text: 'placeholder',
        anchors: [] as string[],
        kind: 'gotcha',
        hits: 0,
        confidence: 0.8,
        date: '2026-08-05',
        ...over,
      }) as Parameters<typeof recall>[0][number];

    test('ranks the relevant fact first', () => {
      const entries = [
        entry({ text: 'Database migrations live in the infra module' }),
        entry({ text: 'JWT access tokens expire after five minutes', anchors: ['appsettings.json:12'] }),
        entry({ text: 'The build script runs tsc then copies prompts' }),
      ];

      const hits = recall(entries, 'how long is the jwt token valid', { now: new Date('2026-08-05') });
      assert.match(hits[0].item.text, /JWT access tokens/);
    });

    test('matches a path fragment against a full anchor', () => {
      const entries = [
        entry({ text: 'Auth is wired here', anchors: ['src/auth/AuthController.cs:20'] }),
        entry({ text: 'Unrelated note about styling' }),
      ];

      const hits = recall(entries, 'authcontroller', { now: new Date('2026-08-05') });
      assert.equal(hits[0].item.text, 'Auth is wired here');
    });

    test('an empty query returns the strongest facts rather than nothing', () => {
      const entries = [entry({ text: 'weak', confidence: 0.3 }), entry({ text: 'strong', confidence: 0.95 })];
      const hits = recall(entries, '', { now: new Date('2026-08-05') });

      assert.equal(hits.length, 2);
      assert.equal(hits[0].item.text, 'strong');
    });

    test('a stale fact loses to a fresh one of equal relevance', () => {
      const now = new Date('2026-08-05');
      const entries = [
        entry({ text: 'The cache uses Redis', date: '2025-01-01' }),
        entry({ text: 'The cache uses Redis', date: '2026-08-01' }),
      ];

      const hits = recall(entries, 'cache redis', { now });
      assert.equal(hits[0].item.date, '2026-08-01');
    });

    test('an old fact is still reachable — decay has a floor', () => {
      const entries = [entry({ text: 'The scheduler is a cron singleton', date: '2019-01-01' })];
      const hits = recall(entries, 'scheduler cron', { now: new Date('2026-08-05') });
      assert.equal(hits.length, 1);
    });

    test('code identifiers are split into searchable parts', () => {
      const tokens = tokenize('src/auth/getUserById.ts');
      assert.ok(tokens.includes('get'));
      assert.ok(tokens.includes('user'));
      assert.ok(tokens.includes('auth'));
    });

    test('recall through the store records a hit on what it served', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      store.rememberFacts([{ text: 'Rate limiting is applied per API key', kind: 'contract' }]);

      const hits = store.recallFacts('rate limiting');
      assert.equal(hits.length, 1);
      assert.equal(store.facts.load()[0].hits, 1);
    });

    test('the directive injects only the facts that rank for the task', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([
        { text: 'JWT access tokens expire after five minutes', kind: 'security' },
        { text: 'The dashboard build output goes to dist/assets', kind: 'config' },
      ]);

      const directive = store.projectDirective('fix the jwt expiry handling');
      assert.match(directive, /JWT access tokens/);
      assert.doesNotMatch(directive, /dashboard build output/);
    });
  });

  describe('similarity and contradiction', () => {
    test('rephrasings score as the same claim, unrelated text does not', () => {
      assert.ok(similarity('Kestrel binds port 6777', 'Kestrel binds port 6777') > 0.99);
      assert.ok(similarity('The API is versioned by URL segment', 'The API is versioned by url segments') > 0.72);
      assert.ok(similarity('Kestrel binds port 6777', 'The dashboard uses Tailwind') < 0.45);
    });

    test('a changed value is a contradiction even when the wording matches', () => {
      const before = 'Kestrel listens on port 6777 in development';
      const after = 'Kestrel listens on port 8080 in development';

      // Similarity alone reads these as the same claim — only one can be true.
      assert.ok(similarity(before, after) > 0.72);
      assert.equal(contradicts(before, after), true);
      assert.equal(contradicts('Tokens expire after 5 minutes', 'Tokens expire after 120 minutes'), true);
    });

    test('rewording without a value change is not a contradiction', () => {
      assert.equal(contradicts('listens on port 6777', 'binds to port 6777'), false);
      assert.equal(contradicts('The API is versioned', 'The API is versioned by segment'), false);
    });

    test('different subjects with different numbers are two facts, not a contradiction', () => {
      // Both true at once. Numbers differ, but so does what they describe.
      const invoice = 'Uploading an invoice larger than 5 MB returns 413 from the gateway';
      const avatar = 'Uploading an avatar larger than 2 MB returns 413 from the gateway';
      assert.equal(contradicts(invoice, avatar), false);
    });

    test('a number inside an identifier names a thing, it does not measure one', () => {
      // Zx500 and Zx600 are different modules; only the digits tell them apart.
      const a = 'The Zx500 module owns billing and must not import Yv500';
      const b = 'The Zx600 module owns billing and must not import Yv600';
      assert.ok(similarity(a, b) > 0.72, 'these read as near-identical sentences');
      assert.equal(contradicts(a, b), false);
      assert.equal(sameClaim(a, b), false);
    });

    test('claims about differently numbered entities are all kept', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      // Numbered entities are ordinary in code: UserV1Controller, mod3.ts, tenant 2.
      for (let i = 0; i < 40; i++) {
        store.rememberFacts([
          { text: `The Zx${i} module owns billing for tenant class Qk${i}`, kind: 'contract' },
        ]);
      }

      assert.equal(store.facts.load().length, 40, 'no claim may be swallowed by a similarly worded neighbour');
    });

    test('a genuine restatement of the same entity still reinforces', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([{ text: 'The Zx500 module owns billing for tenant class Qk500', kind: 'contract' }]);
      const again = store.rememberFacts([
        { text: 'The Zx500 module owns billing for tenant class Qk500', kind: 'contract' },
      ]);

      assert.equal(again.reinforced.length, 1);
      assert.equal(store.facts.load().length, 1);
    });

    test('a restatement carrying no values still reinforces', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([{ text: 'Secrets are read from the environment', kind: 'security' }]);
      const again = store.rememberFacts([{ text: 'Secrets are read from the environment', kind: 'security' }]);

      assert.equal(again.reinforced.length, 1);
      assert.equal(again.superseded.length, 0);
    });
  });

  describe('chat threads', () => {
    test('open, save and brief a thread', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const chat = store.openChat({ title: 'Auth refactor', goal: 'rotate refresh tokens' });
      assert.match(chat.chatId, /^chat-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/);
      assert.equal(chat.status, 'active');

      store.saveChat(chat.chatId, {
        summary: 'token service extracted',
        nextSteps: ['wire rotation into middleware'],
        decisions: ['store refresh tokens hashed'],
        openQuestions: ['grace period for old tokens?'],
        touchedFiles: ['src/auth/token.ts'],
      });

      const directive = store.chatDirective(chat.chatId);
      assert.match(directive, /Auth refactor/);
      assert.match(directive, /Goal: rotate refresh tokens/);
      assert.match(directive, /State: token service extracted/);
      assert.match(directive, /wire rotation into middleware/);
      assert.match(directive, /store refresh tokens hashed/);
      assert.match(directive, /src\/auth\/token\.ts/);
    });

    test('a thread round-trips through markdown on disk', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Persisted', goal: 'survive a restart' });
      store.saveChat(chat.chatId, { summary: 'half done', decisions: ['use sliding expiry'] });

      const raw = sandbox.read(`.agent/memory/chats/${chat.chatId}.md`);
      assert.match(raw, /^# Persisted/);
      assert.match(raw, /goal: survive a restart/);

      const reloaded = store.getChat(chat.chatId)!;
      assert.equal(reloaded.summary, 'half done');
      assert.equal(reloaded.goal, 'survive a restart');
      assert.deepEqual(reloaded.decisions, ['use sliding expiry']);
    });

    test('next steps are replaced while decisions accumulate', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Thread' });

      store.saveChat(chat.chatId, { nextSteps: ['step one'], decisions: ['decision one'] });
      const updated = store.saveChat(chat.chatId, { nextSteps: ['step two'], decisions: ['decision two'] });

      assert.deepEqual(updated.nextSteps, ['step two']);
      assert.deepEqual(updated.decisions, ['decision one', 'decision two']);
    });

    test('the active chat is the most recent non-closed thread', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      const first = store.openChat({ title: 'First' });
      assert.equal(store.getActiveChatId(), first.chatId);

      const second = store.openChat({ title: 'Second' });
      assert.equal(store.getActiveChatId(), second.chatId);

      assert.equal(store.listChats(10).length, 2);
      store.saveChat(second.chatId, { status: 'done' });
      assert.equal(store.listChats(10, 'done').length, 1);
    });

    test('a long log is kept, not silently truncated', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Busy thread' });

      for (let i = 0; i < 60; i++) {
        store.appendChatEvent(chat.chatId, { kind: 'agent', text: `run ${i}` });
      }

      const stored = store.getChat(chat.chatId)!;
      assert.equal(stored.events.length, 60, 'nothing is dropped without being summarized first');
      assert.equal(stored.events.at(-1)!.text, 'run 59');
      assert.equal(store.chats.needingCompaction().length, 1);
    });

    test('chats do not cross projects', () => {
      const a = make('node-ts');
      const b = make('node-ts');
      MemoryStore.for(a.root).openChat({ title: 'Only in A' });

      assert.equal(MemoryStore.for(b.root).listChats(10).length, 0);
      assert.equal(MemoryStore.for(b.root).getActiveChatId(), undefined);
    });
  });

  describe('session transcripts', () => {
    const session = (id: string, updatedAt: number, content = 'hello') =>
      ({
        sessionId: id,
        projectRoot: '',
        projectSlug: 'slug',
        role: 'coder',
        personaName: '@coder',
        systemPrompt: 'sys',
        allowedTools: ['read_file'],
        status: 'completed',
        stepCount: 2,
        totalExecutionTimeMs: 100,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        touchedFiles: ['src/a.ts'],
        createdAt: updatedAt,
        updatedAt,
        messages: [
          { role: 'system', content: 'sys', timestamp: updatedAt },
          { role: 'user', content, timestamp: updatedAt },
        ],
      }) as Parameters<MemoryStore['saveSessionRecord']>[0];

    test('records round-trip and list newest first', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.saveSessionRecord({ ...session('coder-1', 1), projectRoot: sandbox.root });
      store.saveSessionRecord({ ...session('coder-2', 2), projectRoot: sandbox.root });

      assert.equal(store.loadSessionRecord('coder-2')?.sessionId, 'coder-2');
      assert.deepEqual(
        store.listSessionRecords().map((s) => s.sessionId),
        ['coder-2', 'coder-1']
      );

      store.deleteSessionRecord('coder-1');
      assert.equal(store.listSessionRecords().length, 1);
    });

    test('message content that looks like a delimiter survives the round-trip', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const tricky = 'line one\n=== user 123\nline three\n=== not a header';

      store.saveSessionRecord({ ...session('coder-3', 3, tricky), projectRoot: sandbox.root });

      const loaded = store.loadSessionRecord('coder-3')!;
      assert.equal(loaded.messages.length, 2);
      assert.equal(loaded.messages[1].content, tricky);
    });

    test('transcripts are plain text, not JSON', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      store.saveSessionRecord({ ...session('coder-4', 4), projectRoot: sandbox.root });

      assert.ok(sandbox.exists('.agent/memory/sessions/coder-4.txt'));
      assert.match(sandbox.read('.agent/memory/sessions/coder-4.txt'), /^id: coder-4/);
    });

    test('old transcripts are pruned', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const old = Date.now() - 30 * 86_400_000;

      store.saveSessionRecord({ ...session('stale', old), projectRoot: sandbox.root });
      store.saveSessionRecord({ ...session('fresh', Date.now()), projectRoot: sandbox.root });

      assert.equal(store.sessions.prune(), 1);
      assert.deepEqual(
        store.listSessionRecords().map((s) => s.sessionId),
        ['fresh']
      );
    });

    test('linking a session to a chat is idempotent', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Linked' });

      store.linkSession(chat.chatId, 'coder-1');
      store.linkSession(chat.chatId, 'coder-1');

      assert.deepEqual(store.getChat(chat.chatId)!.sessionIds, ['coder-1']);
    });
  });

  describe('stats and the global index', () => {
    test('stats report what memory holds', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);

      store.rememberFacts([
        { text: 'Errors bubble through a Result type', kind: 'convention' },
        { text: 'Secrets are read from the environment only', kind: 'security' },
      ]);
      store.addRule('Never log request bodies');
      store.openChat({ title: 'Some thread' });

      const stats = store.stats();
      assert.equal(stats.facts, 2);
      assert.equal(stats.rules, 1);
      assert.equal(stats.chats, 1);
      assert.equal(stats.activeChats, 1);
      assert.equal(stats.factsByKind.security, 1);
      assert.ok(stats.bytesOnDisk > 0);
    });

    test('the global index is markdown and stays out of $HOME', () => {
      const sandbox = make('node-ts');
      const store = MemoryStore.for(sandbox.root);
      const chat = store.openChat({ title: 'Indexed thread' });

      const entry = MemoryStore.listKnownProjects().find((p) => p.root === sandbox.root);
      assert.ok(entry, 'project should appear in the machine-wide index');
      assert.equal(entry!.activeChatId, chat.chatId);
      assert.equal(entry!.lastChatTitle, 'Indexed thread');

      assert.ok(fs.existsSync(path.join(state.dir, 'PROJECTS.md')));
      assert.ok(!fs.existsSync(path.join(state.dir, 'projects.json')));
    });
  });
});

describe('curator output parsing', () => {
  test('well-formed fact lines are parsed', () => {
    const candidates = parseFactLines(
      [
        'Here are the facts:',
        'FACT | config | server/Program.cs:30 | Kestrel binds 0.0.0.0:6777',
        'FACT | contract | - | The API is versioned by URL segment',
      ].join('\n')
    );

    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].anchors, ['server/Program.cs:30']);
    assert.equal(candidates[0].kind, 'config');
    assert.deepEqual(candidates[1].anchors, []);
  });

  test('malformed lines are skipped rather than guessed at', () => {
    const candidates = parseFactLines(['FACT | config', 'not a fact at all', 'FACT | | | '].join('\n'));
    assert.equal(candidates.length, 0);
  });

  test('an unknown kind falls back instead of being dropped', () => {
    const candidates = parseFactLines('FACT | nonsense | - | Something true about the code');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'gotcha');
  });

  test('a claim containing a pipe survives', () => {
    const candidates = parseFactLines('FACT | config | - | Logs are piped through stdout | stderr split');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /stdout \| stderr split/);
  });
});
