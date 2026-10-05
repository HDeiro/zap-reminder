import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileDeliveryState } from '../src/state.js';

test('persists only the latest successful delivery for each campaign and recipient', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-state-test-'));
  const filePath = join(directory, 'state.json');
  try {
    const state = await FileDeliveryState.create(filePath);
    await state.recordDelivered('water', 'hdeiro', '2026-10-01T14:00[America/Bahia]');
    await state.recordDelivered('water', 'hdeiro', '2026-10-01T15:00[America/Bahia]');

    const restored = await FileDeliveryState.create(filePath);
    assert.equal(restored.wasDelivered('water', 'hdeiro', '2026-10-01T14:00[America/Bahia]'), false);
    assert.equal(restored.wasDelivered('water', 'hdeiro', '2026-10-01T15:00[America/Bahia]'), true);
    assert.match(await readFile(filePath, 'utf8'), /15:00/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prunes state entries for removed campaigns or recipients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-state-test-'));
  const filePath = join(directory, 'state.json');
  try {
    const state = await FileDeliveryState.create(filePath);
    await state.recordDelivered('water', 'hdeiro', '2026-10-01T14:00[America/Bahia]');
    await state.prune(new Set());
    assert.equal(state.wasDelivered('water', 'hdeiro', '2026-10-01T14:00[America/Bahia]'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
