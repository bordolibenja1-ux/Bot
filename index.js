const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const yts = require('yt-search');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// CONFIGURACIÓN DE TELEGRAM BRIDGE
const TELEGRAM_BOT_TOKEN = '8820417770:AAG4caSn5iShyC0vNzQNvmx8yd2qL9h-7RU';
const TELEGRAM_CHAT_ID = '5440165179';

// ARCHIVO PARA GUARDAR USUARIOS AUTORIZADOS DE DOX
const AUTH_FILE = path.resolve(__dirname, 'autorizados.json');

// Cargar usuarios autorizados (por defecto te incluye a vos o a quien configuremos, el primer dueñx siempre sos vos)
function getAuthorizedUsers() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const data = fs.readFileSync(AUTH_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error leyendo autorizados:', e);
    }
    return []; // Lista inicial vacía o con tus admins
}

function saveAuthorizedUsers(users) {
    try {
        fs.writeFileSync(AUTH_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Error guardando autorizados:', e);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('TRAVALAP');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        let phoneNumber = await question('\n📱 Ingresa tu número de WhatsApp con código de país (Ej: 54911xxxxxxxx): ');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        setTimeout(async () => {
            let code = await sock.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            console.log(`\n🔗 Tu código de vinculación es: \x1b[32m${code}\x1b[0m\n`);
            console.log('Ingresa este código en tu WhatsApp: Ajustes > Dispositivos vinculados > Vincular dispositivo > Vincular con el número de teléfono.');
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('\n✅ ¡Bot conectado y listo bajo la sesión "TRAVALAP"!\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m || !m.message) return;

        const messageType = Object.keys(m.message)[0];
        let text = '';
        
        if (messageType === 'conversation') {
            text = m.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            text = m.message.extendedTextMessage.text;
        } else if (messageType === 'imageMessage' && m.message.imageMessage.caption) {
            text = m.message.imageMessage.caption;
        }

        if (!text || typeof text !== 'string') return;
        const from = m.key.remoteJid;
        const sender = m.key.participant || from; // Identifica quién envía el mensaje exactamente
        const isFromMe = m.key.fromMe; // Si el mensaje lo envías vos mismo desde tu celu

        // ================= GESTIÓN DE ACCESO (.AGREGAR / .SACAR) =================
        if (text.toLowerCase().startsWith('.agregar ') || text.toLowerCase().startsWith('.sacar ')) {
            // Solo el dueño (fromMe o vos) puede agregar o sacar gente
            if (!isFromMe) {
                await sock.sendMessage(from, { text: '⚠️ Solo el propietario del bot puede usar este comando.' }, { quoted: m });
                return;
            }

            const esAgregar = text.toLowerCase().startsWith('.agregar ');
            let targetNum = text.slice(esAgregar ? 9 : 7).trim().replace(/[^0-9]/g, '');

            if (!targetNum) {
                await sock.sendMessage(from, { text: `⚠️ Escribe el número. Ej: .${esAgregar ? 'agregar' : 'sacar'} 54911xxxxxxxx` }, { quoted: m });
                return;
            }

            let authorized = getAuthorizedUsers();

            if (esAgregar) {
                if (!authorized.includes(targetNum)) {
                    authorized.push(targetNum);
                    saveAuthorizedUsers(authorized);
                    await sock.sendMessage(from, { text: `✅ Usuario *${targetNum}* agregado con éxito para usar los comandos de consulta.` }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: `ℹ️ El usuario *${targetNum}* ya estaba autorizado.` }, { quoted: m });
                }
            } else {
                authorized = authorized.filter(num => num !== targetNum);
                saveAuthorizedUsers(authorized);
                await sock.sendMessage(from, { text: `🗑️ Usuario *${targetNum}* removido de la lista de autorizados.` }, { quoted: m });
            }
            return;
        }

        // ================= COMANDOS DE CONSULTA (TELEGRAM BRIDGE + AUTORIZACIÓN) =================
        const comandosDox = ['.doxnum', '.doxdni', '.doxuy', '.doxuydni'];
        const isDoxCommand = comandosDox.some(cmd => text.toLowerCase().startsWith(cmd + ' '));

        if (isDoxCommand) {
            // Extraer el número de WhatsApp limpio del remitente (ej: "54911xxxxxx")
            const senderClean = sender.split('@')[0];
            const authorizedUsers = getAuthorizedUsers();

            // Verificación: ¿Es el dueño (fromMe) o está en la lista de autorizados?
            if (!isFromMe && !authorizedUsers.includes(senderClean)) {
                await sock.sendMessage(from, { text: '🚫 No tenés autorización para usar este comando de consulta.' }, { quoted: m });
                return;
            }

            const lowerText = text.toLowerCase();
            let comandoTelegram = '';
            let tipoConsulta = '';

            if (lowerText.startsWith('.doxnum ')) {
                const query = text.slice(8).trim();
                comandoTelegram = `.telar ${query}`;
                tipoConsulta = '.telar';
            } else if (lowerText.startsWith('.doxdni ')) {
                const query = text.slice(8).trim();
                comandoTelegram = `.dniar ${query}`;
                tipoConsulta = '.dniar';
            } else if (lowerText.startsWith('.doxuy ')) {
                const query = text.slice(7).trim();
                comandoTelegram = `.teluy ${query}`;
                tipoConsulta = '.teluy';
            } else if (lowerText.startsWith('.doxuydni ')) {
                const query = text.slice(10).trim();
                comandoTelegram = `.dniuy ${query}`;
                tipoConsulta = '.dniuy';
            }

            const queryData = text.split(' ').slice(1).join(' ').trim();
            if (!queryData) {
                await sock.sendMessage(from, { text: `⚠️ Falta el dato a consultar.` }, { quoted: m });
                return;
            }

            try {
                await sock.sendMessage(from, { text: `🔍 Consultando en Telegram (${tipoConsulta})...` }, { quoted: m });

                const urlTelegram = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
                const respuestaApi = await fetch(urlTelegram, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        text: comandoTelegram
                    })
                });

                const datos = await respuestaApi.json();
                if (!datos.ok) throw new Error('Fallo al conectar con la API de Telegram.');

                setTimeout(async () => {
                    try {
                        const updatesRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1&limit=1`);
                        const updatesData = await updatesRes.json();
                        
                        if (updatesData.ok && updatesData.result.length > 0) {
                            const ultimoMensaje = updatesData.result[0].message;
                            if (ultimoMensaje && ultimoMensaje.text) {
                                await sock.sendMessage(from, { text: `📥 *Resultado (${tipoConsulta}):*\n\n${ultimoMensaje.text}` }, { quoted: m });
                            }
                        }
                    } catch (err) {
                        console.error('Error al capturar respuesta de Telegram:', err);
                    }
                }, 4000);

            } catch (error) {
                console.error('Error en puente:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar la consulta con Telegram.' }, { quoted: m });
            }
        }

        // ================= COMANDO .MUSICA =================
        if (text.toLowerCase().startsWith('.musica')) {
            const query = text.slice(7).trim();
            if (!query) {
                await sock.sendMessage(from, { text: '⚠️ Escribe el nombre de la canción. Ej: *.musica Duki*' }, { quoted: m });
                return;
            }

            try {
                await sock.sendMessage(from, { text: `🔍 Buscando "*${query}*"...` }, { quoted: m });
                const searchResult = await yts(query);
                const video = searchResult.videos[0];

                if (!video) {
                    await sock.sendMessage(from, { text: '❌ No se encontró ninguna canción.' }, { quoted: m });
                    return;
                }

                await sock.sendMessage(from, { text: `📥 Descargando MP3: *${video.title}*...` }, { quoted: m });
                const outputFilePath = path.resolve(__dirname, `${video.videoId}.mp3`);
                const ytdlpCommand = `yt-dlp -x --audio-format mp3 -o "${outputFilePath}" "${video.url}"`;

                exec(ytdlpCommand, async (error) => {
                    if (error || !fs.existsSync(outputFilePath)) {
                        await sock.sendMessage(from, { text: `❌ No se pudo descargar. Link:\n🔗 ${video.url}` }, { quoted: m });
                        return;
                    }

                    await sock.sendMessage(from, {
                        audio: { url: outputFilePath },
                        mimetype: 'audio/mp4',
                        ptt: false,
                        caption: `🎵 ${video.title}`
                    }, { quoted: m });

                    setTimeout(() => {
                        if (fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
                    }, 5000);
                });
            } catch (error) {
                console.error('Error general:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar el audio.' }, { quoted: m });
            }
        }

        // ================= COMANDO .TOP =================
        if (text.toLowerCase().startsWith('.top ')) {
            const motivo = text.slice(5).trim();
            if (!motivo || !from.endsWith('@g.us')) return;

            try {
                const grupoInfo = await sock.groupMetadata(from);
                const participantes = grupoInfo.participants.map(p => p.id);
                if (participantes.length < 10) return;

                const mezcla = participantes.sort(() => Math.random() - 0.5);
                const elegidos = mezcla.slice(0, 10);

                let respuesta = `🏆 *TOP 10: ${motivo.toUpperCase()}* 🏆\n\n`;
                elegidos.forEach((idUsuario, index) => {
                    respuesta += `${index + 1}º @${idUsuario.split('@')[0]}\n`;
                });

                await sock.sendMessage(from, { text: respuesta, mentions: elegidos }, { quoted: m });
            } catch (error) {
                console.error('Error en .top:', error);
            }
        }
    });
}

connectToWhatsApp();
              
