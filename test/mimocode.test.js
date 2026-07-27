import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveMimocodeDbPath } from '../src/parsers/mimocode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

test('MiMoCode is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.mimocode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'mimocode')?.name, 'MiMoCode');
});

test('resolveMimocodeDbPath follows MiMoCode environment precedence', () => {
  assert.equal(resolveMimocodeDbPath({
    MIMOCODE_HOME: '/tmp/mimo-home',
    MIMOCODE_DB: 'channel.db',
  }), '/tmp/mimo-home/data/channel.db');
  assert.equal(resolveMimocodeDbPath({
    MIMOCODE_HOME: '/tmp/mimo-home',
    MIMOCODE_DB: '/tmp/custom.db',
  }), '/tmp/custom.db');
  assert.equal(resolveMimocodeDbPath({
    XDG_DATA_HOME: '/tmp/xdg-data',
  }), '/tmp/xdg-data/mimocode/mimocode.db');
});

test('parse reads exact token usage and session timing from MiMoCode SQLite', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('node:sqlite is unavailable on this Node version');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-mimocode-test-'));
  const dbPath = join(root, 'mimocode.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('ses_1', '/repo/mimo-app');
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    );
    const userCreated = Date.parse('2026-07-27T08:00:00.000Z');
    const assistantCreated = Date.parse('2026-07-27T08:10:00.000Z');
    insert.run('msg_user', 'ses_1', userCreated, JSON.stringify({
      role: 'user',
      time: { created: userCreated },
      model: { modelID: 'mimo-v2.5-pro' },
    }));
    insert.run('msg_assistant', 'ses_1', assistantCreated, JSON.stringify({
      role: 'assistant',
      time: { created: assistantCreated, completed: assistantCreated + 5_000 },
      modelID: 'mimo-v2.5-pro',
      tokens: {
        input: 120,
        output: 30,
        reasoning: 10,
        cache: { read: 400, write: 20 },
      },
    }));
  } finally {
    db.close();
  }

  const previousDb = process.env.MIMOCODE_DB;
  process.env.MIMOCODE_DB = dbPath;
  try {
    const result = await parse();
    assert.deepEqual(result.buckets, [{
      source: 'mimocode',
      model: 'mimo-v2.5-pro',
      project: 'mimo-app',
      bucketStart: '2026-07-27T08:00:00.000Z',
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 400,
      reasoningOutputTokens: 10,
      totalTokens: 160,
    }]);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].source, 'mimocode');
    assert.equal(result.sessions[0].project, 'mimo-app');
    assert.equal(result.sessions[0].firstMessageAt, '2026-07-27T08:00:00.000Z');
    assert.equal(result.sessions[0].lastMessageAt, '2026-07-27T08:10:00.000Z');
    assert.equal(result.sessions[0].durationSeconds, 600);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally {
    if (previousDb === undefined) delete process.env.MIMOCODE_DB;
    else process.env.MIMOCODE_DB = previousDb;
    rmSync(root, { recursive: true, force: true });
  }
});
