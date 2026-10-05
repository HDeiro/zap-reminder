import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket
} from '@whiskeysockets/baileys';

export interface WhatsAppClient {
  connect(): Promise<void>;
  sendMessage(phone: string, message: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

type DisconnectError = { output?: { statusCode?: number } };

export class BaileysWhatsAppClient implements WhatsAppClient {
  private socket?: WASocket;
  private connected = false;
  private stopping = false;
  private reconnectTimer?: NodeJS.Timeout;
  private connectPromise?: Promise<void>;
  private resolveInitialConnection?: () => void;
  private rejectInitialConnection?: (error: Error) => void;

  constructor(private readonly authDirectory = 'auth') {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.stopping = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveInitialConnection = resolve;
      this.rejectInitialConnection = reject;
      void this.openSocket();
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(phone: string, message: string): Promise<void> {
    if (!this.socket || !this.connected) throw new Error('WhatsApp is not connected.');
    const digits = phone.replace(/\D/g, '');
    if (!digits) throw new Error('Contact phone number is empty.');
    await this.socket.sendMessage(`${digits}@s.whatsapp.net`, { text: message });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.end(new Error('Application shutdown'));
  }

  private async openSocket(): Promise<void> {
    if (this.stopping) return;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDirectory);
      if (this.stopping) return;
      const socket = makeWASocket({ auth: state, printQRInTerminal: true });
      this.socket = socket;
      socket.ev.on('creds.update', saveCreds);
      socket.ev.on('connection.update', (update) => {
        if (this.socket !== socket) return;
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          this.connected = true;
          console.info('[INFO] WhatsApp connected');
          this.resolveInitialConnection?.();
          this.resolveInitialConnection = undefined;
          this.rejectInitialConnection = undefined;
          return;
        }
        if (connection !== 'close') return;

        this.connected = false;
        const statusCode = (lastDisconnect?.error as DisconnectError | undefined)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          const error = new Error('WhatsApp logged out. Delete auth/ only if you need to pair the account again.');
          console.error(`[ERROR] ${error.message}`);
          this.rejectInitialConnection?.(error);
          this.resolveInitialConnection = undefined;
          this.rejectInitialConnection = undefined;
          return;
        }
        if (!this.stopping) {
          console.error('[ERROR] WhatsApp disconnected; retrying in 5 seconds.');
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      console.error(`[ERROR] Failed to create WhatsApp connection: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.stopping) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket();
    }, 5_000);
  }
}
