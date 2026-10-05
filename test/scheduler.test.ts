import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig, type ConfigSnapshot } from '../src/config.js';
import { CampaignScheduler, latestOccurrence } from '../src/scheduler.js';
import type { WhatsAppClient } from '../src/whatsapp.js';

function atBahia(hour: number, minute = 0): Date {
  return new Date(`2026-10-05T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`);
}

function snapshot(overrides: Record<string, unknown> = {}): ConfigSnapshot {
  return validateConfig({
    timezone: 'America/Bahia', checkIntervalSeconds: 60,
    contacts: [
      { id: 'joao', name: 'João', phone: '5571999999999' },
      { id: 'maria', name: 'Maria', phone: '5571888888888' }
    ],
    campaigns: [{ id: 'water', name: 'Water', enabled: true, recipients: ['joao', 'maria'], message: 'Drink', schedule: { start: '08:00', end: '22:00', intervalMinutes: 60 } }],
    ...overrides
  });
}

class FakeClient implements WhatsAppClient {
  readonly sends: Array<{ phone: string; message: string }> = [];
  failPhone?: string;
  async connect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async disconnect(): Promise<void> {}
  async sendMessage(phone: string, message: string): Promise<void> {
    if (phone === this.failPhone) throw new Error('temporary failure');
    this.sends.push({ phone, message });
  }
}

test('finds interval occurrences at boundaries and never after a normal window', () => {
  const schedule = { start: '08:00', end: '22:00', intervalMinutes: 60 };
  assert.deepEqual(latestOccurrence(schedule, atBahia(8), 'America/Bahia'), { date: '2026-10-05', time: '08:00' });
  assert.deepEqual(latestOccurrence(schedule, atBahia(8, 30), 'America/Bahia'), { date: '2026-10-05', time: '08:00' });
  assert.deepEqual(latestOccurrence(schedule, atBahia(22), 'America/Bahia'), { date: '2026-10-05', time: '22:00' });
  assert.equal(latestOccurrence(schedule, atBahia(22, 1), 'America/Bahia'), undefined);
});

test('supports 30-minute, fixed-time, and overnight schedules', () => {
  assert.deepEqual(latestOccurrence({ start: '09:00', end: '18:00', intervalMinutes: 30 }, atBahia(10, 1), 'America/Bahia'), { date: '2026-10-05', time: '10:00' });
  assert.deepEqual(latestOccurrence({ times: ['08:00', '12:00', '18:00'] }, atBahia(12, 30), 'America/Bahia'), { date: '2026-10-05', time: '12:00' });
  assert.deepEqual(latestOccurrence({ start: '22:00', end: '02:00', intervalMinutes: 60 }, atBahia(1, 15), 'America/Bahia'), { date: '2026-10-05', time: '01:00' });
  assert.equal(latestOccurrence({ start: '22:00', end: '02:00', intervalMinutes: 60 }, atBahia(12), 'America/Bahia'), undefined);
});

test('does not execute disabled campaigns and de-duplicates successful sends', async () => {
  const client = new FakeClient();
  const scheduler = new CampaignScheduler(() => snapshot(), client);
  await scheduler.checkCampaigns(atBahia(8, 1));
  await scheduler.checkCampaigns(atBahia(8, 30));
  assert.equal(client.sends.length, 2);

  const disabled = new CampaignScheduler(() => snapshot({ campaigns: [{ id: 'water', name: 'Water', enabled: false, recipients: ['joao'], message: 'Drink', schedule: { times: ['08:00'] } }] }), client);
  await disabled.checkCampaigns(atBahia(8));
  assert.equal(client.sends.length, 2);
});

test('continues other recipients and retries a failed recipient', async () => {
  const client = new FakeClient();
  client.failPhone = '5571888888888';
  const scheduler = new CampaignScheduler(() => snapshot(), client);
  await scheduler.checkCampaigns(atBahia(8, 1));
  assert.equal(client.sends.length, 1);
  client.failPhone = undefined;
  await scheduler.checkCampaigns(atBahia(8, 30));
  assert.equal(client.sends.length, 2);
  assert.equal(client.sends[1].phone, '5571888888888');
});
