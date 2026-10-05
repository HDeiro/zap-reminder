# WhatsApp Campaign Bot

Bot pessoal, local e de processo único para enviar lembretes por WhatsApp a partir de campanhas definidas em `config.json`. Ele foi pensado para ficar ligado continuamente em um Raspberry Pi; não usa banco de dados, painel web, API, cron ou serviços externos.

> O projeto usa Baileys, uma integração não oficial do WhatsApp Web. Use uma conta pessoal, envie somente a destinatários que concordaram em receber as mensagens e respeite as políticas aplicáveis do WhatsApp. Mudanças na plataforma podem afetar a conexão.

## Requisitos

- Node.js 20 ou superior (`node --version`)
- Uma conta pessoal do WhatsApp disponível no celular para o primeiro pareamento

## Instalação

```bash
npm install
cp config.example.json config.json
```

Edite `config.json` com seus contatos e campanhas. Ele é ignorado pelo Git para não expor números pessoais.

## Execução

Desenvolvimento:

```bash
npm run dev
```

Build de produção e execução:

```bash
npm run build
npm start
```

Para instalar dependências, gerar o build e iniciar o bot em sequência:

```bash
npm run bootstrap
```

Testes:

```bash
npm test
```

Na primeira inicialização, um QR code será mostrado no terminal. No WhatsApp do celular, abra **Dispositivos conectados** e escaneie-o. Os arquivos da sessão são gravados em `auth/`; mantenha essa pasta no mesmo diretório para que reinícios futuros conectem automaticamente. O QR é gerado pelo próprio bot a partir do evento de conexão do Baileys, compatível com Baileys 7.

## Configuração

O bot lê `config.json` na inicialização e também recarrega alterações válidas automaticamente. Durante uma edição que deixe o JSON inválido, a última configuração válida continua ativa e o erro aparece no log.

```json
{
  "timezone": "America/Bahia",
  "checkIntervalSeconds": 60,

  "contacts": [
    {
      "id": "joao",
      "name": "João",
      "phone": "5571999999999"
    },
    {
      "id": "maria",
      "name": "Maria",
      "phone": "5571888888888"
    },
    {
      "id": "pedro",
      "name": "Pedro",
      "phone": "5571777777777"
    }
  ],

  "campaigns": [
    {
      "id": "water-reminder",
      "name": "Beber água",
      "enabled": true,
      "recipients": ["joao", "maria"],
      "message": "💧 Hora de beber água!",
      "schedule": {
        "start": "08:00",
        "end": "22:00",
        "intervalMinutes": 60
      }
    },
    {
      "id": "morning-reminder",
      "name": "Bom dia",
      "enabled": true,
      "recipients": ["joao", "pedro"],
      "message": "☀️ Bom dia! Tenha um ótimo dia!",
      "schedule": {
        "times": ["08:00"]
      }
    }
  ]
}
```

### Regras

- `timezone` é um timezone IANA, como `America/Bahia`.
- Telefones usam somente dígitos, incluindo código do país (por exemplo, `5571999999999`).
- IDs de contato e campanha são únicos.
- Cada campanha referencia contatos pelos IDs em `recipients`.
- `enabled: false` pausa uma campanha sem apagá-la.
- Um schedule deve ter **exatamente um** formato:

```json
{ "start": "08:00", "end": "22:00", "intervalMinutes": 60 }
```

ou:

```json
{ "times": ["08:00", "12:00", "18:00"] }
```

Para executar apenas em dias específicos de cada mês, combine `daysOfMonth` com `times`:

```json
{ "daysOfMonth": [9], "times": ["09:00"] }
```

Esse exemplo envia às 09:00 no dia 9 de cada mês. Você pode informar vários dias e horários, como `{ "daysOfMonth": [5, 9, 20], "times": ["09:00", "18:00"] }`. O dia 31 é simplesmente ignorado em meses que não o possuem.

Janelas por intervalo podem atravessar meia-noite, por exemplo `{ "start": "22:00", "end": "02:00", "intervalMinutes": 60 }`.

O scheduler verifica imediatamente após conectar e depois a cada `checkIntervalSeconds`. Não há cron. A ocorrência mais recente aplicável é enviada uma vez para cada contato durante a execução atual; após reiniciar, não são reenviadas todas as ocorrências perdidas. Se um envio falhar, somente aquele contato é tentado novamente no próximo ciclo. Isso oferece retentativa, mas em uma falha de rede ambígua pode ocorrer entrega duplicada.

## systemd no Raspberry Pi

O caminho mais simples é executar o instalador incluído. Ele instala dependências, gera o build, cria o serviço, habilita sua inicialização automática no boot e, se já existir uma sessão em `auth/`, inicia o bot:

```bash
cd /opt/whatsapp-bot
chmod +x setup.sh
./setup.sh
```

O script exige Linux com systemd, Node.js 20+ e `sudo`. Ele usa o usuário que o executa para o serviço (se for chamado com `sudo ./setup.sh`, usa o usuário original do `sudo`). Na primeira instalação, sem uma sessão WhatsApp, ele habilita mas não inicia o serviço para que o QR seja pareado em um terminal. Depois do pareamento, o serviço será iniciado automaticamente após cada reinicialização do Raspberry Pi.

Para instalar manualmente, copie o projeto para `/opt/whatsapp-bot`, instale as dependências, faça o build e dê posse ao usuário que executará o serviço:

```bash
sudo mkdir -p /opt/whatsapp-bot
sudo chown -R pi:pi /opt/whatsapp-bot
cd /opt/whatsapp-bot
npm install
npm run build
```

Crie `/etc/systemd/system/whatsapp-bot.service`:

```ini
[Unit]
Description=WhatsApp Campaign Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/whatsapp-bot
ExecStart=/usr/bin/node /opt/whatsapp-bot/dist/src/index.js
Restart=always
RestartSec=5
User=pi
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Ative e inicie:

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-bot
sudo systemctl start whatsapp-bot
sudo systemctl status whatsapp-bot
```

Para o primeiro QR code, é mais fácil executar `npm start` no terminal uma vez, completar o pareamento, interromper com `Ctrl+C` e então iniciar o serviço. A sessão ficará em `/opt/whatsapp-bot/auth/`.

Logs do serviço:

```bash
journalctl -u whatsapp-bot -f
```

Para aplicar uma alteração de código: execute `npm run build` e `sudo systemctl restart whatsapp-bot`. Para campanhas/contatos, basta salvar um `config.json` válido; não é necessário restart.
