import { ConfigStore } from './config.js';
import { CampaignScheduler } from './scheduler.js';
import { BaileysWhatsAppClient } from './whatsapp.js';

async function main(): Promise<void> {
  console.info('[INFO] Loading configuration');
  const configStore = await ConfigStore.create();
  const initial = configStore.get().config;
  console.info(`[INFO] Loaded ${initial.contacts.length} contacts`);
  console.info(`[INFO] Loaded ${initial.campaigns.length} campaigns`);

  const client = new BaileysWhatsAppClient();
  const scheduler = new CampaignScheduler(() => configStore.get(), client);
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
  configStore.onReload((snapshot) => scheduler.updateInterval(snapshot.config.checkIntervalSeconds));
  configStore.startWatching();
  console.info('[INFO] WhatsApp Campaign Bot started');
}

main().catch((error) => {
  console.error(`[ERROR] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
