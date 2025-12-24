const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process'); // Para rodar comandos externos como ffmpeg
const { google } = require('googleapis'); // Para Google Drive API
const path = require('path');
const fs = require('fs');

const app = express();

// ===== CONFIGURAÇÃO DO CORS =====
const allowedOrigins = [
    'https://www.paroquiaauxiliadorairai.com.br',
    'https://webradio-paroquia.onrender.com',
    'http://localhost:3000'
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'CORS policy violation';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;
const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';

// ===== SUAS URLs DOS STREAMS DE RÁDIO =====
const RADIO_VOZ_IMACULADO_URL = 'http://r13.ciclano.io:9033/live'; // Rádio Voz do Coração Imaculado
const RADIO_MARABA_URL = 'https://streaming.speedrs.com.br/radio/8010/maraba'; // Rádio Marabá
const RADIO_CLASSICA_URL = 'https://stream.srg-ssr.ch/m/rsc_de/mp3_128'; // Swiss Classic Radio
const RADIO_AMETISTA_FM_URL = 'https://www.radios.com.br/aovivo/radio-ametista-885-fm/16128'; // Rádio Ametista FM
// ==============================================================================

app.use(express.static('public'));

// ===== VARIÁVEIS GLOBAIS =====
let currentPlayingStream = {
    url: '', // Esta URL será o endpoint LOCAL do seu servidor (ex: '/stream')
    description: ''
};
let lastMainStream = { // Para retornar à rádio anterior após a mensagem
    url: RADIO_VOZ_IMACULADO_URL,
    description: 'Voz do Coração Imaculado'
};
let isPlayingMessage = false;
let messageTimeout = null;
let ffmpegProcess = null; // Variável para armazenar o processo FFmpeg do stream principal
let ffprobeCache = {}; // Cache para armazenar a duração das mensagens

// --- INÍCIO DO BLOCO DE CÓDIGO PARA GOOGLE DRIVE ---

let googleDriveAuth;
let drive;
let messageFilesCache = []; // Esta lista será preenchida dinamicamente!

async function setupGoogleDrive() {
    try {
        let credentials;
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
            credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
            console.log('✅ Credenciais do Google Drive carregadas da variável de ambiente.');
        } else {
            console.error('⚠️ Variável de ambiente GOOGLE_APPLICATION_CREDENTIALS_JSON não encontrada.');
            console.error('   Por favor, configure-a no Render com o conteúdo do seu arquivo JSON de credenciais.');
            process.exit(1);
        }

        googleDriveAuth = new google.auth.JWT(
            credentials.client_email,
            null,
            credentials.private_key,
            ['https://www.googleapis.com/auth/drive.readonly'] // Apenas leitura
        );

        await googleDriveAuth.authorize();
        drive = google.drive({ version: 'v3', auth: googleDriveAuth });
        console.log('✅ Autenticação com Google Drive bem-sucedida.');

    } catch (error) {
        console.error('❌ Erro ao configurar Google Drive:', error.message);
        process.exit(1);
    }
}

async function fetchMessageFilesFromDrive() {
    if (!drive) {
        console.warn('Google Drive não autenticado. Tentando configurar...');
        await setupGoogleDrive();
        if (!drive) {
            console.error('Não foi possível configurar o Google Drive. Pulando a busca de arquivos.');
            return;
        }
    }

    try {
        console.log(`🔄 Buscando arquivos de mensagem na pasta do Google Drive: ${GOOGLE_DRIVE_FOLDER_ID}`);
        const res = await drive.files.list({
            q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType contains 'audio/' and trashed = false`,
            fields: 'files(id, name, webContentLink)',
            pageSize: 1000, // Aumenta o limite para garantir que todos os arquivos sejam pegos
        });

        const files = res.data.files;
        if (files.length) {
            messageFilesCache = files.map(file => ({
                id: file.id,
                name: file.name,
                url: file.webContentLink, // URL para download direto
            }));
            console.log(`✅ ${messageFilesCache.length} arquivos de mensagem carregados do Google Drive.`);
        } else {
            console.log('Nenhum arquivo de mensagem encontrado na pasta do Google Drive.');
        }
    } catch (err) {
        console.error('❌ Erro ao buscar arquivos do Google Drive:', err.message);
        if (messageFilesCache.length === 0) {
            console.warn('Não foi possível carregar do Google Drive e o cache está vazio. As mensagens podem não funcionar.');
        }
    }
}

// --- FIM DO BLOCO DE CÓDIGO PARA GOOGLE DRIVE ---


// Função para iniciar o stream FFmpeg (para rádios ou mensagens)
function startFfmpegStream(sourceUrl, res, isMessage = false) {
    // Se for um stream principal e já houver um processo FFmpeg rodando, encerra-o primeiro
    if (!isMessage && ffmpegProcess) {
        console.log('🔄 Encerrando processo FFmpeg anterior do stream principal...');
        ffmpegProcess.kill('SIGKILL'); // Força o encerramento
        ffmpegProcess = null;
    }

    console.log(`▶️ Iniciando FFmpeg para ${isMessage ? 'mensagem' : 'stream'}: ${sourceUrl}`);
    const ffmpegArgs = [
        '-i', sourceUrl,
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        '-f', 'mp3',
        '-ar', '44100',
        '-ac', '2',
        'pipe:1'
    ];

    const currentFfmpegProcess = spawn('ffmpeg', ffmpegArgs);

    // Se for o stream principal, armazena a referência
    if (!isMessage) {
        ffmpegProcess = currentFfmpegProcess;
    }

    currentFfmpegProcess.stdout.pipe(res);

    currentFfmpegProcess.stderr.on('data', (data) => {
        // Apenas loga se não for o output normal de progresso do FFmpeg
        const dataStr = data.toString();
        if (!dataStr.includes('size=') && !dataStr.includes('time=') && !dataStr.includes('bitrate=')) {
            console.error(`❌ FFmpeg stderr (${isMessage ? 'mensagem' : 'stream'}): ${dataStr}`);
        }
    });

    currentFfmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`❌ FFmpeg process exited with code ${code} for ${isMessage ? 'message' : 'stream'}: ${sourceUrl}`);
        } else {
            console.log(`⏹️ FFmpeg process closed gracefully for ${isMessage ? 'message' : 'stream'}: ${sourceUrl}`);
        }
        if (!isMessage && currentFfmpegProcess === ffmpegProcess) {
            ffmpegProcess = null; // Limpa a referência apenas se for o processo principal atual
        }
    });

    currentFfmpegProcess.on('error', (err) => {
        console.error(`❌ Failed to start FFmpeg process for ${isMessage ? 'message' : 'stream'}:`, err);
        if (!res.headersSent) {
            res.status(500).send(`Erro ao iniciar o stream de ${isMessage ? 'mensagem' : 'rádio'}.`);
        }
        if (!isMessage && currentFfmpegProcess === ffmpegProcess) {
            ffmpegProcess = null;
        }
    });
}

// Rota para o stream principal (rádios)
app.get('/stream', (req, res) => {
    res.set({
        'Content-Type': 'audio/mpeg',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    startFfmpegStream(currentPlayingStream.url, res, false);
});

// Rota para o stream de mensagens do Google Drive
app.get('/message-stream/:id', (req, res) => {
    const messageId = req.params.id;
    const googleDriveUrl = `https://docs.google.com/uc?export=download&id=${messageId}`;
    res.set({
        'Content-Type': 'audio/mpeg',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    startFfmpegStream(googleDriveUrl, res, true); // isMessage = true
});

// Função para obter a duração de um arquivo de áudio usando ffprobe
async function getAudioDuration(fileId) {
    if (ffprobeCache[fileId]) {
        return ffprobeCache[fileId];
    }

    const googleDriveUrl = `https://docs.google.com/uc?export=download&id=${fileId}`;
    console.log(`⏳ Obtendo duração para ${fileId} via ffprobe...`);

    return new Promise((resolve, reject) => {
        const ffprobeProcess = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            googleDriveUrl
        ]);

        let duration = '';
        ffprobeProcess.stdout.on('data', (data) => {
            duration += data.toString();
        });

        ffprobeProcess.on('close', (code) => {
            if (code === 0) {
                const parsedDuration = parseFloat(duration);
                if (!isNaN(parsedDuration)) {
                    ffprobeCache[fileId] = parsedDuration;
                    resolve(parsedDuration);
                } else {
                    console.error(`❌ ffprobe retornou duração inválida para ${fileId}: ${duration}`);
                    resolve(60); // Duração padrão de 60 segundos em caso de erro
                }
            } else {
                console.error(`❌ ffprobe process exited with code ${code} for ${fileId}`);
                resolve(60); // Duração padrão de 60 segundos em caso de erro
            }
        });

        ffprobeProcess.on('error', (err) => {
            console.error(`❌ Failed to start ffprobe process for ${fileId}:`, err);
            resolve(60); // Duração padrão de 60 segundos em caso de erro
        });
    });
}

let currentMessage = null; // Mensagem atualmente em reprodução
let messageSequenceTimeout = null; // Timeout para a próxima mensagem na sequência

// Função para tocar uma mensagem (individual ou em sequência)
async function playMessage(message, isSequence = false) {
    if (!message || !message.id) {
        console.error('❌ Tentativa de tocar mensagem inválida.');
        return;
    }
    if (isPlayingMessage && !isSequence) { // Se já está tocando uma mensagem e não é parte de uma sequência
        console.log(`⚠️ Mensagem ${currentMessage?.name} já está tocando. Ignorando nova solicitação.`);
        return;
    }

    isPlayingMessage = true;
    currentMessage = message;
    console.log(`📢 Iniciando mensagem: ${message.name}`);

    // Envia o comando para o cliente tocar a mensagem
    io.emit('play-mensagem', {
        name: message.name,
        url: `/message-stream/${message.id}` // Usa a nova rota de proxy
    });

    const duration = await getAudioDuration(message.id);
    console.log(`⏳ Mensagem ${message.name} tem duração de ${duration.toFixed(2)} segundos.`);

    // Limpa qualquer timeout anterior para evitar conflitos
    if (messageTimeout) {
        clearTimeout(messageTimeout);
    }

    messageTimeout = setTimeout(() => {
        console.log(`⏹️ Mensagem ${message.name} finalizada (timeout de ${duration}s).`);
        isPlayingMessage = false;
        currentMessage = null;
        io.emit('stop-mensagem'); // Informa o cliente para parar a mensagem

        if (isSequence) {
            // Se for parte de uma sequência, agendamos a próxima mensagem
            scheduleNextMessageInSequence();
        } else {
            // Se não for sequência, retorna ao stream principal
            setMainStream();
        }
    }, duration * 1000); // Converte segundos para milissegundos
}

// Variáveis para a sequência de mensagens das 11h
let isPlayingMessageSequence = false;
let currentMessageSequenceIndex = 0;
let messageSequenceEndTimeout = null; // Timeout para finalizar a sequência às 12h

// Função para agendar a próxima mensagem na sequência
function scheduleNextMessageInSequence() {
    if (!isPlayingMessageSequence) {
        console.log('Sequência de mensagens finalizada ou interrompida.');
        return;
    }

    if (messageFilesCache.length === 0) {
        console.warn('Não há mensagens no cache para a sequência.');
        stopMessageSequence();
        return;
    }

    // Toca a próxima mensagem na ordem, ou volta para o início se chegou ao fim
    const messageToPlay = messageFilesCache[currentMessageSequenceIndex];
    currentMessageSequenceIndex = (currentMessageSequenceIndex + 1) % messageFilesCache.length;

    playMessage(messageToPlay, true); // Passa 'true' para indicar que é parte de uma sequência
}

// Função para iniciar a sequência de mensagens das 11h
function startMessageSequence() {
    if (isPlayingMessageSequence) {
        console.log('⚠️ Sequência de mensagens das 11h já está ativa.');
        return;
    }
    if (messageFilesCache.length === 0) {
        console.warn('Não há mensagens carregadas para iniciar a sequência das 11h.');
        return;
    }

    console.log('🚀 Iniciando sequência de mensagens do Google Drive (11h00-12h00).');
    isPlayingMessageSequence = true;
    currentMessageSequenceIndex = 0; // Começa do início da lista

    // Define o stream principal como "Mensagens do Google Drive"
    currentPlayingStream = {
        url: '/message-stream', // Uma URL simbólica, pois o cliente vai tocar via 'play-mensagem'
        description: 'Mensagens do Google Drive'
    };
    io.emit('play-stream', currentPlayingStream); // Notifica o cliente para mudar a descrição

    scheduleNextMessageInSequence(); // Inicia a primeira mensagem

    // Agenda o fim da sequência para 12h00
    const now = new Date();
    const msUntil12h = (12 * 60 * 60 * 1000) - (now.getHours() * 60 * 60 * 1000 + now.getMinutes() * 60 * 1000 + now.getSeconds() * 1000 + now.getMilliseconds());

    if (msUntil12h > 0) {
        messageSequenceEndTimeout = setTimeout(stopMessageSequence, msUntil12h);
        console.log(`⏰ Sequência de mensagens agendada para terminar em ${msUntil12h / 1000 / 60} minutos.`);
    } else {
        // Se já passou das 12h (por algum motivo), para imediatamente
        stopMessageSequence();
    }
}

// Função para parar a sequência de mensagens
function stopMessageSequence() {
    if (!isPlayingMessageSequence) return;

    console.log('🛑 Finalizando sequência de mensagens do Google Drive (12h00).');
    isPlayingMessageSequence = false;
    if (messageSequenceEndTimeout) {
        clearTimeout(messageSequenceEndTimeout);
        messageSequenceEndTimeout = null;
    }
    if (messageTimeout) { // Garante que a mensagem atual pare
        clearTimeout(messageTimeout);
        messageTimeout = null;
    }
    isPlayingMessage = false; // Garante que o estado de "tocando mensagem" seja resetado
    currentMessage = null;
    io.emit('stop-mensagem'); // Informa o cliente para parar a mensagem
    setMainStream(); // Retorna ao stream principal
}


// Função para definir o stream principal com base na programação
function setMainStream() {
    // Se a sequência de mensagens das 11h estiver ativa, não muda o stream principal
    if (isPlayingMessageSequence) {
        console.log('⚠️ Não alterando stream principal, sequência de mensagens das 11h está tocando.');
        return;
    }
    if (isPlayingMessage) {
        console.log('⚠️ Não alterando stream principal, mensagem individual está tocando.');
        return;
    }

    const now = new Date();
    const day = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeInMinutes = hours * 60 + minutes;

    let newStream = {
        url: RADIO_VOZ_IMACULADO_URL,
        description: 'Voz do Coração Imaculado'
    };

    // ===== PROGRAMAÇÃO ESPECIAL =====
    // Domingo: Rádio Marabá (Missa) 8h30-9h45
    if (day === 0 && currentTimeInMinutes >= (8 * 60 + 30) && currentTimeInMinutes < (9 * 60 + 45)) {
        newStream = {
            url: RADIO_MARABA_URL,
            description: 'Rádio Marabá (Missa)'
        };
    }
    // Sábado: Missa Rádio Ametista FM 19h00-20h30
    else if (day === 6 && currentTimeInMinutes >= (19 * 60) && currentTimeInMinutes < (20 * 60 + 30)) {
        newStream = {
            url: RADIO_AMETISTA_FM_URL,
            description: 'Rádio Ametista FM (Missa de Sábado)'
        };
    }
    // Sábado: Programa específico do sábado 12h50-13h05
    else if (day === 6 && currentTimeInMinutes >= (12 * 60 + 50) && currentTimeInMinutes < (13 * 60 + 5)) {
        newStream = {
            url: RADIO_VOZ_IMACULADO_URL,
            description: 'Voz do Coração Imaculado (Programa de Sábado)'
        };
    }
    // Madrugada Clássica: 00h10-05h00
    else if (currentTimeInMinutes >= (0 * 60 + 10) && currentTimeInMinutes < (5 * 60)) {
        newStream = {
            url: RADIO_CLASSICA_URL,
            description: 'Swiss Classic Radio (Madrugada Clássica)'
        };
    }
    // Horário das 11h00-12h00: Mensagens do Google Drive (NOVO BLOCO DE PROGRAMAÇÃO!)
    else if (currentTimeInMinutes >= (11 * 60) && currentTimeInMinutes < (12 * 60)) {
        // A lógica de startMessageSequence() já cuida da reprodução e do estado
        // Aqui, apenas garantimos que o currentPlayingStream reflita isso
        newStream = {
            url: '/message-stream', // URL simbólica
            description: 'Mensagens do Google Drive'
        };
    }
    // A partir das 05:00, retorna à Voz da Imaculada (se não houver outra programação)
    else if (currentTimeInMinutes >= (5 * 60) && newStream.url === RADIO_VOZ_IMACULADO_URL) {
        // Já é o default, mas explicitando para clareza
        newStream = {
            url: RADIO_VOZ_IMACULADO_URL,
            description: 'Voz do Coração Imaculado'
        };
    }


    // Verifica se o stream mudou
    if (newStream.url !== currentPlayingStream.url) {
        currentPlayingStream = newStream;
        lastMainStream = newStream; // Atualiza o último stream principal válido
        console.log(`📻 Trocando para o stream principal: ${currentPlayingStream.description}`);
        io.emit('play-stream', currentPlayingStream); // Notifica o cliente para tocar o novo stream
    } else {
        console.log(`📻 Stream principal permanece: ${currentPlayingStream.description}`);
    }
}

// ===== AGENDAMENTO DE MENSAGENS =====
// Mensagens diárias (fora da madrugada clássica E fora do bloco das 11h-12h)
const dailyMessageTimes = [
    '55 9 * * *',   // 9:55
    '40 12 * * *',  // 12:40
    '52 13 * * *',  // 13:52
    '30 14 * * *',  // 14:30
    '50 15 * * *',  // 15:50
    '20 16 * * *',  // 16:20
    '13 17 * * *',  // 17:13
    '55 18 * * *',  // 18:55
    '55 19 * * *',  // 19:55
    '50 23 * * *'   // 23:50
];

dailyMessageTimes.forEach(time => {
    cron.schedule(time, () => {
        const now = new Date();
        const hours = now.getHours();
        // Não toca mensagens diárias se estiver na Madrugada Clássica (00h00 a 04h59)
        // OU se estiver no bloco de mensagens das 11h-12h
        if (!(hours >= 0 && hours < 5) && !(hours === 11)) { // Ajustado para 00h00 a 04h59 E fora das 11h
            if (messageFilesCache.length > 0) {
                const randomMessage = messageFilesCache[Math.floor(Math.random() * messageFilesCache.length)];
                playMessage(randomMessage);
            } else {
                console.warn('Não há mensagens carregadas do Google Drive para tocar nas mensagens diárias.');
            }
        }
    });
});

// Mensagens na Madrugada Clássica (00:10 até 05:00, a cada 30 minutos)
cron.schedule('10,40 0-4 * * *', () => { // Aos 10 e 40 minutos das horas 0, 1, 2, 3, 4
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    // Garante que só toque se estiver dentro do período 00:10-05:00
    if ((hours === 0 && minutes >= 10) || (hours > 0 && hours < 5)) {
        if (messageFilesCache.length > 0) {
            const randomMessage = messageFilesCache[Math.floor(Math.random() * messageFilesCache.length)];
            playMessage(randomMessage);
        } else {
            console.warn('Não há mensagens carregadas do Google Drive para tocar na madrugada clássica.');
        }
    }
});

// ===== NOVO AGENDAMENTO: SEQUÊNCIA DE MENSAGENS DAS 11H00 ÀS 12H00 =====
cron.schedule('0 11 * * *', () => { // Todos os dias, às 11h00
    startMessageSequence();
});

// Inicializa a programação ao iniciar o servidor
setMainStream();
// Atualiza a programação a cada minuto
cron.schedule('* * * * *', setMainStream);

// ===== INICIANDO O SERVIDOR =====
// Antes de iniciar o servidor, configuramos o Google Drive e carregamos as mensagens
setupGoogleDrive().then(() => {
    fetchMessageFilesFromDrive().then(() => {
        server.listen(PORT, () => {
            console.log(`
╔═════════════════════════════════════════════════════╗
║                                                     ║
║  📡 Servidor iniciado com sucesso na porta ${PORT}  ║
║  📂 Google Drive: ${GOOGLE_DRIVE_FOLDER_ID}        ║
║  📊 Mensagens carregadas: ${messageFilesCache.length}  ║
║  🎵 Rádio Principal: ${currentPlayingStream.description}  ║
║  🎼 Clássica: 00h10-05h00 (msgs a cada 30min)       ║
║  ⛪ Domingo: Missa Marabá 8h30-9h45                 ║
║  📻 Sábado: Missa Ametista 19h00-20h30              ║
║  📻 Sábado: Voz do Pastor 12h50-13h05               ║
║  ⏰ Mensagens diárias: 9:55, 12:40, 13:52...         ║
║  🗣️ Mensagens em sequência: 11h00-12h00 (NOVO!)    ║
╚═════════════════════════════════════════════════════╝
            `);
        });
    });
}).catch(error => {
    console.error('❌ Falha crítica ao iniciar o servidor devido a erro no Google Drive:', error);
    process.exit(1); // Sai se não conseguir configurar o Drive
});

// Função para tocar o stream principal (chamada pelo cliente)
function playMainStream() {
    if (!isPlayingMessage && !isPlayingMessageSequence) { // Verifica também a sequência
        io.emit('play-stream', currentPlayingStream);
    }
}
