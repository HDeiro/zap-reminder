import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Contact {
  id: string;
  name: string;
  phone: string;
}

export interface IntervalSchedule {
  start: string;
  end: string;
  intervalMinutes: number;
}

export interface TimesSchedule {
  times: string[];
}

export interface MonthlyTimesSchedule extends TimesSchedule {
  daysOfMonth: number[];
}

export type Schedule = IntervalSchedule | TimesSchedule | MonthlyTimesSchedule;

export interface Campaign {
  id: string;
  name: string;
  enabled: boolean;
  recipients: string[];
  message: string;
  schedule: Schedule;
}

export interface BotConfig {
  timezone: string;
  checkIntervalSeconds: number;
  contacts: Contact[];
  campaigns: Campaign[];
}

export interface ConfigSnapshot {
  config: BotConfig;
  contactsById: ReadonlyMap<string, Contact>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid configuration: ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} must be a non-empty string.`);
  return value.trim();
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    fail(`timezone "${timezone}" is not a valid IANA timezone.`);
  }
}

function validateSchedule(value: unknown, campaignId: string): Schedule {
  if (!isRecord(value)) fail(`campaign "${campaignId}" schedule must be an object.`);

  const hasTimes = Object.hasOwn(value, 'times');
  const hasDaysOfMonth = Object.hasOwn(value, 'daysOfMonth');
  const hasIntervalFields = Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end') || Object.hasOwn(value, 'intervalMinutes');
  if (hasIntervalFields && (hasTimes || hasDaysOfMonth)) {
    fail(`campaign "${campaignId}" must have exactly one schedule format (interval, times, or daysOfMonth with times).`);
  }
  if (!hasIntervalFields && !hasTimes) {
    fail(`campaign "${campaignId}" must have a schedule (interval, times, or daysOfMonth with times).`);
  }

  if (hasTimes) {
    if (!Array.isArray(value.times) || value.times.length === 0) {
      fail(`campaign "${campaignId}" schedule.times must be a non-empty array.`);
    }
    const times = value.times.map((time, index) => {
      const parsed = requireString(time, `campaign "${campaignId}" schedule.times[${index}]`);
      if (!isValidTime(parsed)) fail(`campaign "${campaignId}" has invalid time "${parsed}". Use HH:mm.`);
      return parsed;
    });
    if (new Set(times).size !== times.length) fail(`campaign "${campaignId}" schedule.times contains duplicates.`);
    if (!hasDaysOfMonth) return { times };
    if (!Array.isArray(value.daysOfMonth) || value.daysOfMonth.length === 0) {
      fail(`campaign "${campaignId}" schedule.daysOfMonth must be a non-empty array.`);
    }
    const daysOfMonth = value.daysOfMonth.map((day, index) => {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
        fail(`campaign "${campaignId}" schedule.daysOfMonth[${index}] must be an integer from 1 to 31.`);
      }
      return day;
    });
    if (new Set(daysOfMonth).size !== daysOfMonth.length) fail(`campaign "${campaignId}" schedule.daysOfMonth contains duplicates.`);
    return { times, daysOfMonth };
  }

  const start = requireString(value.start, `campaign "${campaignId}" schedule.start`);
  const end = requireString(value.end, `campaign "${campaignId}" schedule.end`);
  if (!isValidTime(start) || !isValidTime(end)) fail(`campaign "${campaignId}" start and end must use HH:mm.`);
  if (typeof value.intervalMinutes !== 'number' || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes <= 0) {
    fail(`campaign "${campaignId}" intervalMinutes must be a positive integer.`);
  }
  return { start, end, intervalMinutes: value.intervalMinutes };
}

export function validateConfig(value: unknown): ConfigSnapshot {
  if (!isRecord(value)) fail('root must be an object.');
  const timezone = requireString(value.timezone, 'timezone');
  validateTimezone(timezone);
  if (typeof value.checkIntervalSeconds !== 'number' || !Number.isInteger(value.checkIntervalSeconds) || value.checkIntervalSeconds <= 0) {
    fail('checkIntervalSeconds must be a positive integer.');
  }
  if (!Array.isArray(value.contacts)) fail('contacts must be an array.');
  if (!Array.isArray(value.campaigns)) fail('campaigns must be an array.');

  const contactIds = new Set<string>();
  const contacts = value.contacts.map((raw, index): Contact => {
    if (!isRecord(raw)) fail(`contacts[${index}] must be an object.`);
    const id = requireString(raw.id, `contacts[${index}].id`);
    if (contactIds.has(id)) fail(`duplicate contact id "${id}".`);
    contactIds.add(id);
    const phone = requireString(raw.phone, `contact "${id}" phone`);
    if (!/^\d+$/.test(phone)) fail(`contact "${id}" phone must contain digits only.`);
    return { id, name: requireString(raw.name, `contact "${id}" name`), phone };
  });

  const campaignIds = new Set<string>();
  const campaigns = value.campaigns.map((raw, index): Campaign => {
    if (!isRecord(raw)) fail(`campaigns[${index}] must be an object.`);
    const id = requireString(raw.id, `campaigns[${index}].id`);
    if (campaignIds.has(id)) fail(`duplicate campaign id "${id}".`);
    campaignIds.add(id);
    if (typeof raw.enabled !== 'boolean') fail(`campaign "${id}" enabled must be a boolean.`);
    if (!Array.isArray(raw.recipients) || raw.recipients.length === 0) fail(`campaign "${id}" recipients must be a non-empty array.`);
    const recipients = raw.recipients.map((recipient, recipientIndex) => {
      const recipientId = requireString(recipient, `campaign "${id}" recipients[${recipientIndex}]`);
      if (!contactIds.has(recipientId)) fail(`campaign "${id}": recipient "${recipientId}" does not exist.`);
      return recipientId;
    });
    if (new Set(recipients).size !== recipients.length) fail(`campaign "${id}" recipients contains duplicates.`);
    return {
      id,
      name: requireString(raw.name, `campaign "${id}" name`),
      enabled: raw.enabled,
      recipients,
      message: requireString(raw.message, `campaign "${id}" message`),
      schedule: validateSchedule(raw.schedule, id)
    };
  });

  const config: BotConfig = { timezone, checkIntervalSeconds: value.checkIntervalSeconds, contacts, campaigns };
  return { config, contactsById: new Map(contacts.map((contact) => [contact.id, contact])) };
}

export async function loadConfig(filePath = resolve(process.cwd(), 'config.json')): Promise<ConfigSnapshot> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateConfig(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid configuration: config.json contains invalid JSON: ${error.message}`);
    throw error;
  }
}

export class ConfigStore {
  private snapshot: ConfigSnapshot;
  private watcher?: FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly listeners = new Set<(snapshot: ConfigSnapshot) => void>();

  private constructor(private readonly filePath: string, snapshot: ConfigSnapshot) {
    this.snapshot = snapshot;
  }

  static async create(filePath = resolve(process.cwd(), 'config.json')): Promise<ConfigStore> {
    return new ConfigStore(filePath, await loadConfig(filePath));
  }

  get(): ConfigSnapshot {
    return this.snapshot;
  }

  onReload(listener: (snapshot: ConfigSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startWatching(): void {
    this.openWatcher();
  }

  private openWatcher(): void {
    if (this.closed) return;
    this.watcher?.close();
    try {
      this.watcher = watch(this.filePath, () => this.scheduleReload());
      this.watcher.on('error', (error) => console.error(`[ERROR] Config watcher failed: ${error.message}`));
    } catch (error) {
      console.error(`[ERROR] Cannot watch config.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reload(), 250);
  }

  private async reload(): Promise<void> {
    try {
      const next = await loadConfig(this.filePath);
      this.snapshot = next;
      console.info(`[INFO] Configuration reloaded (${next.config.contacts.length} contacts, ${next.config.campaigns.length} campaigns)`);
      for (const listener of this.listeners) listener(next);
    } catch (error) {
      console.error(`[ERROR] Configuration reload rejected; keeping the last valid configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Some editors save by replacing the file, which invalidates an fs.watch descriptor.
    this.openWatcher();
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
  }
}
