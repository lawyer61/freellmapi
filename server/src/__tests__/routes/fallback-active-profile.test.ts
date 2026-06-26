import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function firstTwoProfileModelIds(profileId: number): [number, number] {
  const rows = getDb().prepare(`
    SELECT pm.model_db_id
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC
    LIMIT 2
  `).all(profileId) as { model_db_id: number }[];
  expect(rows.length).toBe(2);
  return [rows[0].model_db_id, rows[1].model_db_id];
}

function putFallbackFirst(a: number, b: number): void {
  const db = getDb();
  db.prepare('UPDATE fallback_config SET priority = priority + 1000').run();
  db.prepare('UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?').run(a);
  db.prepare('UPDATE fallback_config SET priority = 2 WHERE model_db_id = ?').run(b);
}

function putProfileFirst(profileId: number, a: number, b: number): void {
  const db = getDb();
  db.prepare('UPDATE profile_models SET priority = priority + 1000 WHERE profile_id = ?').run(profileId);
  db.prepare('UPDATE profile_models SET priority = 1 WHERE profile_id = ? AND model_db_id = ?').run(profileId, a);
  db.prepare('UPDATE profile_models SET priority = 2 WHERE profile_id = ? AND model_db_id = ?').run(profileId, b);
}

describe('Fallback API with an active profile', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('GET /api/fallback returns the active profile order', async () => {
    const profileId = activeProfileId();
    const [fallbackFirst, profileFirst] = firstTwoProfileModelIds(profileId);
    putFallbackFirst(fallbackFirst, profileFirst);
    putProfileFirst(profileId, profileFirst, fallbackFirst);

    const { status, body } = await request(app, 'GET', '/api/fallback');

    expect(status).toBe(200);
    expect(body[0].modelDbId).toBe(profileFirst);
  });

  it('PUT /api/fallback updates the active profile order without rewriting fallback_config', async () => {
    const profileId = activeProfileId();
    const [a, b] = firstTwoProfileModelIds(profileId);
    putFallbackFirst(a, b);
    putProfileFirst(profileId, a, b);

    const { status } = await request(app, 'PUT', '/api/fallback', [
      { modelDbId: a, priority: 2, enabled: true },
      { modelDbId: b, priority: 1, enabled: false },
    ]);

    expect(status).toBe(200);
    const db = getDb();
    const profileA = db.prepare('SELECT priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profileId, a) as { priority: number; enabled: number };
    const profileB = db.prepare('SELECT priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profileId, b) as { priority: number; enabled: number };
    const fallbackA = db.prepare('SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?').get(a) as { priority: number; enabled: number };
    const fallbackB = db.prepare('SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?').get(b) as { priority: number; enabled: number };

    expect(profileA).toEqual({ priority: 2, enabled: 1 });
    expect(profileB).toEqual({ priority: 1, enabled: 0 });
    expect(fallbackA).toEqual({ priority: 1, enabled: 1 });
    expect(fallbackB).toEqual({ priority: 2, enabled: 1 });
  });

  it('POST /api/fallback/sort/speed reorders the active profile', async () => {
    const profileId = activeProfileId();
    const db = getDb();
    const fastest = db.prepare(`
      SELECT pm.model_db_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
      WHERE pm.profile_id = ?
      ORDER BY m.speed_rank ASC
      LIMIT 1
    `).get(profileId) as { model_db_id: number };
    const slowest = db.prepare(`
      SELECT pm.model_db_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
      WHERE pm.profile_id = ?
      ORDER BY m.speed_rank DESC
      LIMIT 1
    `).get(profileId) as { model_db_id: number };
    expect(fastest.model_db_id).not.toBe(slowest.model_db_id);
    putProfileFirst(profileId, slowest.model_db_id, fastest.model_db_id);

    const { status } = await request(app, 'POST', '/api/fallback/sort/speed');

    expect(status).toBe(200);
    const first = db.prepare(`
      SELECT pm.model_db_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
      WHERE pm.profile_id = ?
      ORDER BY pm.priority ASC
      LIMIT 1
    `).get(profileId) as { model_db_id: number };
    expect(first.model_db_id).toBe(fastest.model_db_id);
  });
});
