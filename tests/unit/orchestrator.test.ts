import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, createStateDir, Sandbox } from '../helpers/sandbox.js';

const state = createStateDir();
process.env.DEEPSEEK_MCP_STATE_DIR = state.dir;

const { Orchestrator, MAX_SPAWN_DEPTH } = await import('../../src/orchestrator/Orchestrator.js');
const { SubagentManager } = await import('../../src/subagents/SubagentManager.js');
const { RunStore } = await import('../../src/orchestrator/RunStore.js');
const { compilePlan, PlanError } = await import('../../src/orchestrator/plan.js');
const { clearClaims } = await import('../../src/orchestrator/claims.js');
const { WORKSPACE_TOOLS } = await import('../../src/subagents/tools/workspaceTools.js');
import type { SubagentRunOptions, SubagentRunResult } from '../../src/subagents/types.js';
import type { Plan, Run } from '../../src/orchestrator/types.js';

/**
 * The scheduler is exercised against a stub subagent rather than a real one:
 * every property worth asserting here — ordering, handoff, blocking, gates,
 * cancellation — is a property of the graph, and paying a model to observe it
 * would make these tests both slower and less deterministic.
 */
type AgentStub = (options: SubagentRunOptions) => Promise<string> | string;

function stubAgent(fn: AgentStub): void {
  (SubagentManager.prototype as any).run = async (options: SubagentRunOptions): Promise<SubagentRunResult> => {
    const content = await fn(options);
    return {
      sessionId: `${options.role}-stub-${Math.random().toString(36).slice(2, 6)}`,
      projectRoot: options.projectRoot || '',
      role: options.role || 'general',
      personaName: `@${options.role}`,
      status: 'completed',
      content,
      modelUsed: 'stub',
      executionTimeMs: 1,
      isNewSession: true,
      allowedTools: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      touchedFiles: [],
      toolCallsMade: 0,
    };
  };
}

/** A promise the test resolves by hand, for holding tasks in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const realRun = SubagentManager.prototype.run;

describe('orchestrator', () => {
  let sandbox: Sandbox;
  let orchestrator: InstanceType<typeof Orchestrator>;

  const plan = (goal: string, tasks: Plan['tasks']): Plan => ({ goal, tasks });

  const start = (p: Plan, maxParallel?: number): Run =>
    orchestrator.start({ plan: p, projectRoot: sandbox.root, maxParallel });

  const finish = (run: Run) => orchestrator.wait(run.runId, 5_000, sandbox.root);

  beforeEach(() => {
    sandbox = createSandbox('node-ts');
    orchestrator = Orchestrator.getInstance();
    orchestrator.reset();
    clearClaims();
  });

  afterEach(() => {
    (SubagentManager.prototype as any).run = realRun;
    sandbox.cleanup();
  });

  // ------------------------------------------------------------- ordering

  test('a task waits for what it needs and inherits the answer', async () => {
    const order: string[] = [];
    let handoff = '';

    stubAgent((options) => {
      order.push(options.task);
      if (options.task === 'second') handoff = options.context || '';
      return `answer to ${options.task}`;
    });

    const run = start(
      plan('ordered work', [
        { id: 'b', task: 'second', needs: ['a'] },
        { id: 'a', task: 'first' },
      ])
    );
    await finish(run);

    assert.deepEqual(order, ['first', 'second'], 'the dependency runs first regardless of array order');
    assert.match(handoff, /answer to first/, 'the dependent receives its predecessor answer as context');
    assert.equal(run.status, 'done');
    assert.equal(
      run.tasks.every((t) => t.state === 'done'),
      true
    );
  });

  test('independent tasks run at the same time', async () => {
    const gate = deferred();
    let concurrent = 0;
    let peak = 0;

    stubAgent(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await gate.promise;
      concurrent--;
      return 'ok';
    });

    const run = start(
      plan('fan out', [
        { id: 'one', task: '1' },
        { id: 'two', task: '2' },
        { id: 'three', task: '3' },
      ]),
      3
    );

    // Let all three reach the stub before releasing any of them.
    await new Promise((r) => setImmediate(r));
    gate.resolve();
    await finish(run);

    assert.equal(peak, 3, `three independent tasks should have been in flight together, peak was ${peak}`);
    assert.equal(run.status, 'done');
  });

  test('the parallelism ceiling is respected', async () => {
    const gate = deferred();
    let concurrent = 0;
    let peak = 0;

    stubAgent(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await gate.promise;
      concurrent--;
      return 'ok';
    });

    const run = start(
      plan('fan out, capped', [
        { id: 'one', task: '1' },
        { id: 'two', task: '2' },
        { id: 'three', task: '3' },
        { id: 'four', task: '4' },
      ]),
      2
    );

    await new Promise((r) => setImmediate(r));
    assert.equal(peak, 2, `maxParallel 2 should hold two tasks in flight, peak was ${peak}`);
    gate.resolve();
    await finish(run);
    assert.equal(run.status, 'done');
  });

  // -------------------------------------------------------------- failure

  test('a failed task blocks its dependents and spares the rest of the graph', async () => {
    stubAgent((options) => {
      if (options.task === 'breaks') throw new Error('the model refused');
      return 'ok';
    });

    const run = start(
      plan('one branch fails', [
        { id: 'bad', task: 'breaks' },
        { id: 'downstream', task: 'needs the broken one', needs: ['bad'] },
        { id: 'elsewhere', task: 'unrelated' },
      ])
    );
    await finish(run);

    const byId = new Map(run.tasks.map((t) => [t.id, t]));
    assert.equal(byId.get('bad')!.state, 'failed');
    assert.equal(byId.get('bad')!.error, 'the model refused');
    assert.equal(byId.get('downstream')!.state, 'blocked');
    assert.equal(byId.get('elsewhere')!.state, 'done', 'an unrelated branch should still finish');
    assert.equal(run.status, 'failed');
  });

  test('onFail "continue" lets dependents run with the error as context', async () => {
    let inherited = '';
    stubAgent((options) => {
      if (options.task === 'breaks') throw new Error('no network');
      inherited = options.context || '';
      return 'carried on';
    });

    const run = start(
      plan('survivable failure', [
        { id: 'bad', task: 'breaks', onFail: 'continue' },
        { id: 'after', task: 'carry on', needs: ['bad'] },
      ])
    );
    await finish(run);

    assert.equal(run.tasks.find((t) => t.id === 'after')!.state, 'done');
    assert.match(inherited, /FAILED: no network/, 'the dependent is told what went wrong upstream');
  });

  test('onFail "abort" cancels the whole run', async () => {
    const gate = deferred();
    stubAgent(async (options) => {
      if (options.task === 'breaks') throw new Error('fatal');
      await gate.promise;
      return 'ok';
    });

    const run = start(
      plan('abort on failure', [
        { id: 'bad', task: 'breaks', onFail: 'abort' },
        { id: 'other', task: 'long running' },
      ]),
      2
    );
    await finish(run);
    gate.resolve();

    assert.equal(run.status, 'cancelled');
    assert.match(run.note || '', /aborted/);
  });

  test('a task retries up to its budget before failing', async () => {
    let attempts = 0;
    stubAgent(() => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'succeeded on the third';
    });

    const run = start(plan('retry', [{ id: 'flaky', task: 'unstable', retries: 2 }]));
    await finish(run);

    assert.equal(attempts, 3);
    assert.equal(run.tasks[0].state, 'done');
    assert.equal(run.tasks[0].attempts, 3);
  });

  // ---------------------------------------------------------------- gates

  test('a checkpoint stops the graph until the coordinator reports back', async () => {
    const ran: string[] = [];
    stubAgent((options) => {
      ran.push(options.task);
      return 'ok';
    });

    const run = start(
      plan('verify before continuing', [
        { id: 'impl', task: 'write it' },
        { id: 'verify', kind: 'checkpoint', task: 'run npm test and report the output', needs: ['impl'] },
        { id: 'fix', task: 'fix what the tests found', needs: ['verify'] },
      ])
    );
    await orchestrator.wait(run.runId, 5_000, sandbox.root);

    assert.equal(run.status, 'waiting');
    assert.equal(run.tasks.find((t) => t.id === 'verify')!.state, 'awaiting');
    assert.deepEqual(ran, ['write it'], 'nothing past the checkpoint may run');

    let handoff = '';
    stubAgent((options) => {
      handoff = options.context || '';
      return 'fixed';
    });
    orchestrator.approve(run.runId, 'verify', '2 tests failing in auth.test.ts', sandbox.root);
    await finish(run);

    assert.equal(run.status, 'done');
    assert.match(handoff, /2 tests failing in auth\.test\.ts/, 'the coordinator report is the checkpoint result');
  });

  test('rejecting a gate skips it and blocks what depended on it', async () => {
    stubAgent(() => 'ok');

    const run = start(
      plan('gated write', [
        { id: 'risky', task: 'delete things', gate: true },
        { id: 'after', task: 'depends on it', needs: ['risky'] },
      ])
    );
    await orchestrator.wait(run.runId, 5_000, sandbox.root);

    assert.equal(run.tasks[0].state, 'awaiting');
    orchestrator.reject(run.runId, 'risky', 'too destructive', sandbox.root);
    await finish(run);

    assert.equal(run.tasks.find((t) => t.id === 'risky')!.state, 'skipped');
    assert.equal(run.tasks.find((t) => t.id === 'after')!.state, 'blocked');
  });

  test('an approved gate runs the task it was holding', async () => {
    stubAgent(() => 'written');
    const run = start(plan('gated', [{ id: 'risky', task: 'write it', gate: true }]));
    await orchestrator.wait(run.runId, 5_000, sandbox.root);

    assert.equal(run.tasks[0].state, 'awaiting');
    orchestrator.approve(run.runId, 'risky', undefined, sandbox.root);
    await finish(run);
    assert.equal(run.tasks[0].state, 'done');
    assert.equal(run.tasks[0].result, 'written');
  });

  // --------------------------------------------------------- cancellation

  test('stopping a run aborts the subagent it is waiting on', async () => {
    let aborted = false;
    stubAgent(
      (options) =>
        new Promise<string>((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('cancelled'));
          });
        })
    );

    const run = start(plan('long', [{ id: 'slow', task: 'never finishes' }]));
    await new Promise((r) => setImmediate(r));

    orchestrator.stop(run.runId, sandbox.root);
    await new Promise((r) => setImmediate(r));

    assert.equal(aborted, true, 'the in-flight model call must be cancelled, not merely abandoned');
    assert.equal(run.status, 'cancelled');
    assert.equal(run.tasks[0].state, 'cancelled');
  });

  test('shutdown records what was in flight, and resume re-queues it', async () => {
    stubAgent(
      (options) =>
        new Promise<string>((_, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        })
    );

    const run = start(
      plan('interrupted work', [
        { id: 'running-one', task: 'in flight' },
        { id: 'later', task: 'downstream', needs: ['running-one'] },
      ])
    );
    await new Promise((r) => setImmediate(r));

    orchestrator.shutdown('host disconnected');

    // What matters is the file, because that is all a new process will have.
    const onDisk = new RunStore(sandbox.root).load(run.runId)!;
    assert.equal(onDisk.status, 'interrupted');
    assert.equal(onDisk.tasks.find((t) => t.id === 'running-one')!.state, 'interrupted');
    assert.equal(onDisk.tasks.find((t) => t.id === 'later')!.state, 'pending');

    // A fresh process: nothing in memory, everything from the file.
    orchestrator.reset();
    stubAgent(() => 'finished after the restart');
    const resumed = orchestrator.resume(run.runId, sandbox.root);
    await orchestrator.wait(resumed.runId, 5_000, sandbox.root);

    assert.equal(resumed.status, 'done');
    assert.equal(resumed.tasks.find((t) => t.id === 'running-one')!.result, 'finished after the restart');
  });

  test('a superseded attempt cannot report over the one that replaced it', async () => {
    // The abandoned call settles late — after resume has already relaunched the
    // task. It must not touch the graph, and it must not flush a stale run file.
    const stale = deferred();
    stubAgent(
      (options) =>
        new Promise<string>((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            void stale.promise.then(() => reject(new Error('the abandoned attempt, reporting late')));
          });
        })
    );

    const run = start(plan('late settle', [{ id: 'a', task: 'work' }]));
    await new Promise((r) => setImmediate(r));

    orchestrator.shutdown('host disconnected');
    orchestrator.reset();

    stubAgent(() => 'the attempt that actually counts');
    const resumed = orchestrator.resume(run.runId, sandbox.root);
    await orchestrator.wait(resumed.runId, 5_000, sandbox.root);

    // Only now does the abandoned attempt come back.
    stale.resolve();
    await new Promise((r) => setImmediate(r));

    assert.equal(resumed.status, 'done');
    assert.equal(resumed.tasks[0].result, 'the attempt that actually counts');
    assert.equal(new RunStore(sandbox.root).load(run.runId)!.status, 'done', 'the file must not be rewritten by the stale attempt');
  });

  test('a run left running by a dead process is reported as interrupted, not running', async () => {
    stubAgent(() => 'ok');
    const run = start(plan('orphan', [{ id: 'a', task: 'work' }]));
    await finish(run);

    // Forge the state a killed process leaves behind.
    const store = new RunStore(sandbox.root);
    const stored = store.load(run.runId)!;
    stored.status = 'running';
    stored.tasks[0].state = 'running';
    store.save(stored);

    orchestrator.reset();
    const reloaded = orchestrator.get(run.runId, sandbox.root)!;
    assert.equal(reloaded.status, 'interrupted');
    assert.equal(reloaded.tasks[0].state, 'interrupted');
  });

  // ---------------------------------------------------------------- spawn

  test('a task that may delegate gets a child registered in the run', async () => {
    stubAgent(async (options) => {
      if (options.orchestration?.taskId === 'lead') {
        const child = await options.orchestration.spawn({ role: 'coder', task: 'write the helper' });
        return `delegated: ${child.content}`;
      }
      return 'helper written';
    });

    const run = start(plan('delegation', [{ id: 'lead', task: 'organise', allowSpawn: true }]));
    await finish(run);

    assert.equal(run.tasks.length, 2, 'the child is a visible node of the run, not hidden work');
    const child = run.tasks.find((t) => t.parent === 'lead')!;
    assert.equal(child.depth, 1);
    assert.equal(child.state, 'done');
    assert.equal(child.role, 'coder');
    assert.match(run.tasks[0].result || '', /helper written/);
    // Each row carries its own cost only; rolling the child's into the parent
    // would double-count it in the run total, since the child has a row too.
    assert.equal(run.tasks[0].tokens, 20);
    assert.equal(child.tokens, 20);
  });

  test('delegation stops at the depth ceiling', async () => {
    let deepestAllowed = -1;
    let refusal = '';

    stubAgent(async (options) => {
      const depth = options.orchestration?.depth ?? 0;
      deepestAllowed = Math.max(deepestAllowed, depth);
      try {
        await options.orchestration!.spawn({ role: 'general', task: `deeper than ${depth}` });
      } catch (err: any) {
        refusal = err.message;
      }
      return `depth ${depth}`;
    });

    const run = start(plan('runaway delegation', [{ id: 'lead', task: 'organise', allowSpawn: true }]));
    await finish(run);

    assert.equal(deepestAllowed, MAX_SPAWN_DEPTH, `delegation should reach depth ${MAX_SPAWN_DEPTH} and no further`);
    assert.match(refusal, /depth/i, 'the refusal has to say why, or the model will just try again');
  });

  test('a delegate may not hold a permission its parent lacks', async () => {
    let childTools: string[] | undefined;
    stubAgent(async (options) => {
      if (options.orchestration?.taskId === 'lead') {
        await options.orchestration.spawn({
          role: 'coder',
          task: 'write a file',
          allowedTools: ['read_file', 'write_file', 'delete_file'],
        });
        return 'done';
      }
      childTools = options.allowedTools as string[];
      return 'ok';
    });

    const run = start(
      plan('permission floor', [
        { id: 'lead', task: 'organise', allowSpawn: true, allowedTools: ['read_file', 'search_files'] },
      ])
    );
    await finish(run);

    assert.deepEqual(childTools, ['read_file'], 'write_file and delete_file are not the parent\'s to hand out');
  });

  // ------------------------------------------------------------- handoff

  test('a long predecessor answer is capped before it reaches the dependent', async () => {
    const huge = 'x'.repeat(50_000);
    let received = '';

    stubAgent((options) => {
      if (options.task === 'big') return huge;
      received = options.context || '';
      return 'ok';
    });

    const run = start(
      plan('bounded handoff', [
        { id: 'big', task: 'big' },
        { id: 'reader', task: 'read it', needs: ['big'] },
      ])
    );
    await finish(run);

    assert.ok(received.length < 10_000, `the handoff was ${received.length} chars; it must be capped`);
    assert.match(received, /truncated/);
  });

  // -------------------------------------------------------------- claims

  test('two tasks cannot write the same file', async () => {
    const ctxFor = (taskId: string) => ({
      root: sandbox.root,
      touchedFiles: [] as string[],
      orchestration: {
        runId: 'run-x',
        taskId,
        depth: 0,
        allowSpawn: false,
        maxDepth: 2,
        spawn: async () => {
          throw new Error('not used');
        },
      },
    });

    const first = await WORKSPACE_TOOLS.write_file.execute(
      { path: 'src/shared.ts', content: 'export const a = 1;\n' },
      ctxFor('one')
    );
    const second = await WORKSPACE_TOOLS.write_file.execute(
      { path: 'src/shared.ts', content: 'export const a = 2;\n' },
      ctxFor('two')
    );

    assert.match(first, /Created/);
    assert.match(second, /being written by task 'one'/);
    assert.equal(sandbox.read('src/shared.ts'), 'export const a = 1;\n', 'the first writer keeps the file');
  });

  test('a plain agent call is not subject to claims', async () => {
    const ctx = { root: sandbox.root, touchedFiles: [] as string[] };
    await WORKSPACE_TOOLS.write_file.execute({ path: 'src/free.ts', content: 'one' }, ctx);
    const again = await WORKSPACE_TOOLS.write_file.execute({ path: 'src/free.ts', content: 'two' }, ctx);
    assert.match(again, /^Overwrote/);
  });

  test('spawn_agent refuses outside a run', async () => {
    const out = await WORKSPACE_TOOLS.spawn_agent.execute(
      { task: 'do something' },
      { root: sandbox.root, touchedFiles: [] }
    );
    assert.match(out, /only available to a task running inside an orchestrated run/);
  });
});

// ----------------------------------------------------------- plan validation

describe('plan validation', () => {
  const ok = { id: 'a', task: 'do a thing' };

  test('accepts a well-formed plan', () => {
    const tasks = compilePlan({ goal: 'g', tasks: [ok, { id: 'b', task: 'later', needs: ['a'] }] });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].state, 'pending');
    assert.equal(tasks[0].onFail, 'block');
  });

  test('a checkpoint is always a gate', () => {
    const [task] = compilePlan({ goal: 'g', tasks: [{ id: 'v', task: 'run tests', kind: 'checkpoint' }] });
    assert.equal(task.gate, true);
  });

  test('rejects a dependency cycle and names it', () => {
    assert.throws(
      () =>
        compilePlan({
          goal: 'g',
          tasks: [
            { id: 'a', task: 'a', needs: ['c'] },
            { id: 'b', task: 'b', needs: ['a'] },
            { id: 'c', task: 'c', needs: ['b'] },
          ],
        }),
      (err: any) => err instanceof PlanError && /cycle: a -> c -> b -> a/.test(err.message)
    );
  });

  test('rejects an unknown dependency, a duplicate id and an empty plan', () => {
    assert.throws(
      () => compilePlan({ goal: 'g', tasks: [{ id: 'a', task: 'a', needs: ['ghost'] }] }),
      /needs 'ghost', which is not in the plan/
    );
    assert.throws(() => compilePlan({ goal: 'g', tasks: [ok, ok] }), /Duplicate task id 'a'/);
    assert.throws(() => compilePlan({ goal: 'g', tasks: [] }), /at least one task/);
    assert.throws(() => compilePlan({ goal: '', tasks: [ok] }), /needs a "goal"/);
  });

  test('clamps retries and steps rather than trusting them', () => {
    const [task] = compilePlan({ goal: 'g', tasks: [{ id: 'a', task: 'a', retries: 99, maxSteps: 500 }] });
    assert.equal(task.retries, 2);
    assert.equal(task.maxSteps, 20);
  });
});

// ------------------------------------------------------------- persistence

describe('run persistence', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox('empty');
  });
  afterEach(() => sandbox.cleanup());

  test('a run round-trips through the file exactly', () => {
    const store = new RunStore(sandbox.root);
    const tasks = compilePlan({
      goal: 'round trip',
      tasks: [
        { id: 'a', task: 'first\nwith a second line', role: 'explore' },
        { id: 'b', task: 'second', needs: ['a'], kind: 'checkpoint' },
      ],
    });

    // A subagent answer is markdown, and markdown contains exactly the
    // sequences this format uses as delimiters.
    tasks[0].result = 'Findings:\n\n--- task\n== task fake\nand a real answer';
    tasks[0].state = 'done';
    tasks[0].tokens = 4213;
    tasks[0].touchedFiles = ['src/a.ts', 'src/b.ts'];
    tasks[1].error = 'nothing to verify';

    const run: Run = {
      runId: 'run-2026-08-06-test',
      goal: 'round trip',
      status: 'waiting',
      projectRoot: sandbox.root,
      chatId: 'chat-1',
      tasks,
      maxParallel: 3,
      createdAt: 1_000,
      updatedAt: 2_000,
      note: 'a note',
    };

    store.save(run);
    const loaded = store.load(run.runId)!;

    // Compared through JSON, because that is the fidelity that matters: an
    // absent optional and one explicitly set to undefined mean the same thing
    // to every consumer of a run.
    const shape = (value: unknown) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(shape(loaded), shape(run));
  });

  test('missing runs come back undefined instead of throwing', () => {
    assert.equal(new RunStore(sandbox.root).load('run-nope'), undefined);
    assert.deepEqual(new RunStore(sandbox.root).list(), []);
  });
});
