import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, validateConfig } from '../src/config.js';

function validConfig(): Record<string, unknown> {
  return {
    timezone: 'America/Bahia',
    checkIntervalSeconds: 60,
    contacts: [{ id: 'joao', name: 'João', phone: '5571999999999' }],
    campaigns: [{
      id: 'water', name: 'Water', enabled: true, recipients: ['joao'], message: 'Drink',
      schedule: { start: '08:00', end: '22:00', intervalMinutes: 60 }
    }]
  };
}

test('accepts a valid interval configuration', () => {
  const snapshot = validateConfig(validConfig());
  assert.equal(snapshot.config.contacts.length, 1);
  assert.equal(snapshot.contactsById.get('joao')?.name, 'João');
});

test('accepts monthly schedules and rejects invalid days of the month', () => {
  const monthly = validConfig();
  (monthly.campaigns as Array<Record<string, unknown>>)[0].schedule = { daysOfMonth: [9, 20], times: ['09:00'] };
  assert.deepEqual(validateConfig(monthly).config.campaigns[0].schedule, { daysOfMonth: [9, 20], times: ['09:00'] });

  const invalidDay = validConfig();
  (invalidDay.campaigns as Array<Record<string, unknown>>)[0].schedule = { daysOfMonth: [0], times: ['09:00'] };
  assert.throws(() => validateConfig(invalidDay), /integer from 1 to 31/);
});

test('rejects invalid JSON in the configuration file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-bot-test-'));
  const filePath = join(directory, 'config.json');
  try {
    await writeFile(filePath, '{ not json', 'utf8');
    await assert.rejects(loadConfig(filePath), /contains invalid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects duplicate contact and campaign IDs', () => {
  const duplicateContact = validConfig();
  duplicateContact.contacts = [
    { id: 'joao', name: 'João', phone: '5571999999999' },
    { id: 'joao', name: 'Outro', phone: '5571888888888' }
  ];
  assert.throws(() => validateConfig(duplicateContact), /duplicate contact id/);

  const duplicateCampaign = validConfig();
  duplicateCampaign.campaigns = [
    { id: 'same', name: 'One', enabled: true, recipients: ['joao'], message: 'One', schedule: { times: ['08:00'] } },
    { id: 'same', name: 'Two', enabled: true, recipients: ['joao'], message: 'Two', schedule: { times: ['09:00'] } }
  ];
  assert.throws(() => validateConfig(duplicateCampaign), /duplicate campaign id/);
});

test('rejects missing recipients and invalid schedule values', () => {
  const unknownRecipient = validConfig();
  (unknownRecipient.campaigns as Array<Record<string, unknown>>)[0].recipients = ['missing'];
  assert.throws(() => validateConfig(unknownRecipient), /recipient "missing" does not exist/);

  const invalidTime = validConfig();
  (invalidTime.campaigns as Array<Record<string, unknown>>)[0].schedule = { start: '25:00', end: '22:00', intervalMinutes: 60 };
  assert.throws(() => validateConfig(invalidTime), /must use HH:mm/);

  const invalidInterval = validConfig();
  (invalidInterval.campaigns as Array<Record<string, unknown>>)[0].schedule = { start: '08:00', end: '22:00', intervalMinutes: 0 };
  assert.throws(() => validateConfig(invalidInterval), /positive integer/);
});

test('rejects mixed schedule formats and invalid timezones', () => {
  const mixed = validConfig();
  (mixed.campaigns as Array<Record<string, unknown>>)[0].schedule = { start: '08:00', end: '22:00', intervalMinutes: 60, times: ['12:00'] };
  assert.throws(() => validateConfig(mixed), /exactly one schedule format/);

  const invalidTimezone = validConfig();
  invalidTimezone.timezone = 'Mars/Olympus';
  assert.throws(() => validateConfig(invalidTimezone), /valid IANA timezone/);
});
