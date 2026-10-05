import { ConfigStore } from './config.js';
import { CampaignScheduler } from './scheduler.js';
import { FileDeliveryState } from './state.js';
import { BaileysWhatsAppClient } from './whatsapp.js';

function currentDeliveryEntries(configStore: ConfigStore): Set<string> {
  const entries = new Set<string>();
  for (const campaign of configStore.get().config.campaigns) {
    for (const recipientId of campaign.recipients) {
      entries.add(FileDeliveryState.entryKey(campaign.id, recipientId));
    }
  }
  return entries;
}

async function main(): Promise<void> {
  console.info('[INFO] Loading configuration');
  const configStore = await ConfigStore.create();
  const initial = configStore.get().config;
  console.info(`[INFO] Loaded ${initial.contacts.length} contacts`);
  console.info(`[INFO] Loaded ${initial.campaigns.length} campaigns`);

  const deliveryState = await FileDeliveryState.create();
  await deliveryState.prune(currentDeliveryEntries(configStore));
  const client = new BaileysWhatsAppClient();
  const scheduler = new CampaignScheduler(() => configStore.get(), client, deliveryState);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[INFO] Received ${signal}; shutting down`);
    configStore.close();
    await scheduler.stop();
    await client.disconnect();
    console.info('[INFO] Shutdown complete');
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  console.info('[INFO] Connecting to WhatsApp');
  await client.connect();
  await scheduler.checkCampaigns();
  scheduler.start(configStore.get().config.checkIntervalSeconds);
  configStore.onReload((snapshot) => {
    scheduler.updateInterval(snapshot.config.checkIntervalSeconds);
    void deliveryState.prune(currentDeliveryEntries(configStore)).catch((error) => {
      console.error(`[ERROR] Failed to prune delivery state: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  configStore.startWatching();
  console.info('[INFO] WhatsApp Campaign Bot started');
}

main().catch((error) => {
  console.error(`[ERROR] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
