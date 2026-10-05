import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface DeliveryState {
  wasDelivered(campaignId: string, recipientId: string, occurrenceId: string): boolean;
  recordDelivered(campaignId: string, recipientId: string, occurrenceId: string): Promise<void>;
}

interface PersistedState {
  lastDelivered: Record<string, string>;
}

function entryKey(campaignId: string, recipientId: string): string {
  return JSON.stringify([campaignId, recipientId]);
}

function parseState(value: unknown): PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('state.json root must be an object.');
  }
  const lastDelivered = (value as Record<string, unknown>).lastDelivered;
  if (typeof lastDelivered !== 'object' || lastDelivered === null || Array.isArray(lastDelivered)) {
    throw new Error('state.json lastDelivered must be an object.');
  }
  for (const [key, occurrenceId] of Object.entries(lastDelivered)) {
    if (typeof occurrenceId !== 'string' || occurrenceId.length === 0) {
      throw new Error(`state.json entry "${key}" must have a non-empty occurrence value.`);
    }
  }
  return { lastDelivered: { ...(lastDelivered as Record<string, string>) } };
}

export class FileDeliveryState implements DeliveryState {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly state: PersistedState
  ) {}

  static async create(filePath = resolve(process.cwd(), 'state.json')): Promise<FileDeliveryState> {
    try {
      const contents = await readFile(filePath, 'utf8');
      try {
        return new FileDeliveryState(filePath, parseState(JSON.parse(contents) as unknown));
      } catch (error) {
        throw new Error(`Invalid state file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new FileDeliveryState(filePath, { lastDelivered: {} });
      }
      throw error;
    }
  }

  wasDelivered(campaignId: string, recipientId: string, occurrenceId: string): boolean {
    return this.state.lastDelivered[entryKey(campaignId, recipientId)] === occurrenceId;
  }

  async recordDelivered(campaignId: string, recipientId: string, occurrenceId: string): Promise<void> {
    await this.enqueue(async () => {
      this.state.lastDelivered[entryKey(campaignId, recipientId)] = occurrenceId;
      await this.save();
    });
  }

  async prune(allowedEntries: ReadonlySet<string>): Promise<void> {
    await this.enqueue(async () => {
      let changed = false;
      for (const key of Object.keys(this.state.lastDelivered)) {
        if (!allowedEntries.has(key)) {
          delete this.state.lastDelivered[key];
          changed = true;
        }
      }
      if (changed) await this.save();
    });
  }

  static entryKey(campaignId: string, recipientId: string): string {
    return entryKey(campaignId, recipientId);
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
