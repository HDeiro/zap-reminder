import type { Campaign, ConfigSnapshot, IntervalSchedule, Schedule } from './config.js';
import type { WhatsAppClient } from './whatsapp.js';

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  minutes: number;
}

export interface Occurrence {
  date: string;
  time: string;
}

function minutesFromTime(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(minutes: number): string {
  const normalized = ((minutes % 1_440) + 1_440) % 1_440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function dateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDate(year: number, month: number, day: number, days: number): string {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return dateString(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function localDateTime(now: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const hour = get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), minutes: hour * 60 + get('minute') };
}

function isIntervalSchedule(schedule: Schedule): schedule is IntervalSchedule {
  return 'intervalMinutes' in schedule;
}

export function latestOccurrence(schedule: Schedule, now: Date, timezone: string): Occurrence | undefined {
  const local = localDateTime(now, timezone);
  const today = dateString(local.year, local.month, local.day);

  if (!isIntervalSchedule(schedule)) {
    const due = [...schedule.times].sort().filter((time) => minutesFromTime(time) <= local.minutes).at(-1);
    return due ? { date: today, time: due } : undefined;
  }

  const start = minutesFromTime(schedule.start);
  const end = minutesFromTime(schedule.end);
  const crossesMidnight = start > end;
  let elapsed: number;
  let anchorDate = today;

  if (!crossesMidnight) {
    if (local.minutes < start || local.minutes > end) return undefined;
    elapsed = local.minutes - start;
  } else if (local.minutes >= start) {
    elapsed = local.minutes - start;
  } else if (local.minutes <= end) {
    elapsed = local.minutes + 1_440 - start;
    anchorDate = shiftDate(local.year, local.month, local.day, -1);
  } else {
    return undefined;
  }

  const dueMinutes = start + Math.floor(elapsed / schedule.intervalMinutes) * schedule.intervalMinutes;
  if (dueMinutes > (crossesMidnight ? end + 1_440 : end)) return undefined;
  const date = dueMinutes >= 1_440 ? shiftDate(...anchorDate.split('-').map(Number) as [number, number, number], 1) : anchorDate;
  return { date, time: timeFromMinutes(dueMinutes) };
}

export class CampaignScheduler {
  private readonly completed = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    private readonly getSnapshot: () => ConfigSnapshot,
    private readonly client: WhatsAppClient
  ) {}

  async checkCampaigns(now = new Date()): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const snapshot = this.getSnapshot();
      console.info('[INFO] Checking campaigns');
      for (const campaign of snapshot.config.campaigns) {
        if (this.stopping || !campaign.enabled) continue;
        const occurrence = latestOccurrence(campaign.schedule, now, snapshot.config.timezone);
        if (!occurrence) continue;
        console.info(`[INFO] Campaign "${campaign.name}" is due (${occurrence.date} ${occurrence.time})`);
        await this.deliverCampaign(campaign, occurrence, snapshot);
      }
    } finally {
      this.running = false;
    }
  }

  private async deliverCampaign(campaign: Campaign, occurrence: Occurrence, snapshot: ConfigSnapshot): Promise<void> {
    for (const recipientId of campaign.recipients) {
      if (this.stopping) return;
      const key = `${campaign.id}:${recipientId}:${occurrence.date}T${occurrence.time}[${snapshot.config.timezone}]`;
      if (this.completed.has(key)) continue;
      const contact = snapshot.contactsById.get(recipientId);
      if (!contact) continue;
      try {
        console.info(`[INFO] Sending message to ${contact.name}`);
        await this.client.sendMessage(contact.phone, campaign.message);
        this.completed.add(key);
        console.info(`[INFO] Message sent to ${contact.name}`);
      } catch (error) {
        console.error(`[ERROR] Failed to send message to ${contact.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  start(intervalSeconds: number): void {
    this.stopping = false;
    this.replaceTimer(intervalSeconds);
  }

  updateInterval(intervalSeconds: number): void {
    if (!this.stopping) this.replaceTimer(intervalSeconds);
  }

  private replaceTimer(intervalSeconds: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.checkCampaigns(), intervalSeconds * 1_000);
    console.info(`[INFO] Scheduler started (${intervalSeconds}s)`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
