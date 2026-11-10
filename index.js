const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const yts = require('yt-search');

// Configuración de Telegram
const TELEGRAM_TOKEN = '8820417770:AAG4caSn5iShyC0vNzQNvmx8yd2qL9h-7RU';
const CHAT_ID = '5440165179';

// Función para enviar consultas al Bot de Telegram y esperar la respuesta
async function consultarTelegram(query) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: `🤖 **Consulta desde WhatsApp (TRAVALAP):**\n${query}`
        });

        let offset = 0;
        const inicio = Date.now();
        
        while (Date.now() - inicio < 30000) {
            const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`, {
                params: { offset, timeout: 5 }
            });

            const updates = res.data.result;
            for (const update of updates) {
                offset = update.update_id + 1;
                if (update.message && update.message.text) {
                    return update.message.text;
                }
            }
        }
        return "⚠️ Tiempo de espera agotado para la respuesta de la base de datos.";
    } catch (error) {
        console.error("Error al conectar con Telegram:", error);
        return "❌ Error interno al procesar la consulta en la red.";
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        }
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        const phoneNumber = "5491136007490"; 
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n🔑 ==========================================`);
                console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${code}`);
                console.log(`🔑 ==========================================\n`);
            } catch (e) {
                console.error("Error al pedir código de vinculación:", e);
            }
        }, 4000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('¡TRAVALAP conectado con éxito a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

        if (!text.startsWith('.')) return;

        const args = text.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const queryText = args.join(' ');

        // Comandos de puente a Telegram (Libres para todos)
        if (['doxnum', 'telar', 'doxdni', 'dniar', 'doxuy', 'teluy', 'doxuydni', 'dniuy'].includes(command)) {
            if (!queryText) {
                await sock.sendMessage(remoteJid, { text: `⚠️ Por favor ingresa un parámetro. Ejemplo: .${command} [DNI o Teléfono]` });
                return;
            }

            await sock.sendMessage(remoteJid, { text: '🔍 Procesando consulta a través de la base de datos...' });
            const resultadoTelegram = await consultarTelegram(`Comando: .${command} ${queryText}`);
            await sock.sendMessage(remoteJid, { text: `📊 **Resultado TRAVALAP:**\n\n${resultadoTelegram}` });
            return;
        }

        // Comando de YouTube (Libre para todos)
        if (command === 'play' || command === 'yt') {
            if (!queryText) return sock.sendMessage(remoteJid, { text: '⚠️ Ingresa el nombre de lo que querés buscar en YouTube.' });
            try {
                const search = await yts(queryText);
                const vid = search.videos[0];
                if (!vid) return sock.sendMessage(remoteJid, { text: '❌ No se encontraron resultados.' });

                await sock.sendMessage(remoteJid, { 
                    text: `🎵 *Resultado de YouTube*\n\n📌 Título: ${vid.title}\n⏱️ Duración: ${vid.timestamp}\n🔗 Link: ${vid.url}` 
                });
            } catch (err) {
                await sock.sendMessage(remoteJid, { text: '❌ Ocurrió un error al buscar en YouTube.' });
            }
            return;
        }
    });
}

startBot();
               
