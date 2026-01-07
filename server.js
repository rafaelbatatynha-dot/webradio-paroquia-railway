// server.js - Web Rádio Paróquia (versão final, completa, pronta para uso)

process.env.TZ = 'America/Sao_Paulo';

const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const cors = require('cors');
const cron = require('node-cron');
const { google } = require('googleapis');
const { spawn, exec } = require('child_process');
const ytdl = require('ytdl-core');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: { origin: '*' }
});

app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ----------------------------- CONFIGURAÇÕES -----------------------------

const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';
const YOUTUBE_MISSA_VIDEO_ID = 'ZlXnuZcaJ2Y';

const STREAMS = {
    maraba: {
        url: 'https://streaming.speedrs.com.br/radio/8010/maraba',
        description: 'Rádio Marabá'
    },
    imaculado: {
        url: 'http://r13.ciclano.io:9033/live',
        description: 'Voz do Coração Imaculado'
    },
    classica: {
        url: 'https://stream.srg-ssr.ch/m/rsc_de/mp3_128',
        description: 'Música Clássica'
    },
    missaYoutube: {
        url: `https://www.youtube.com/watch?v=${YOUTUBE_MISSA_VIDEO_ID}`,
        description: 'Missa de Sábado – YouTube'
    }
};

let currentStream = STREAMS.imaculado;
let messages = [];
let isPlayingMessage = false;
let blockRunning = false;
let previousStreamBeforeBlock = STREAMS.imaculado;

// ----------------------------- LOG BRASIL -----------------------------

function log(msg) {
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`[${agora}] ${msg}`);
}

// ------------------------ GOOGLE DRIVE ------------------------

async function authenticateGoogleDrive() {
    try {
        const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        if (!json) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON ausente");

        const creds = JSON.parse(json);
        const auth = new google.auth.GoogleAuth({
            credentials: creds,
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });

        log("Google Drive autenticado");
        return auth;
    } catch (err) {
        log("Erro Drive: " + err.message);
        return null;
    }
}

async function loadMessages(auth) {
    try {
        if (!auth) return;

        const drive = google.drive({ version: 'v3', auth });

        const resp = await drive.files.list({
            q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType contains 'audio'`,
            fields: 'files(id,name)',
            pageSize: 500
        });

        const files = resp.data.files || [];
        messages = files.map(f => ({
            id: f.id,
            name: f.name,
            url: `https://drive.google.com/uc?id=${f.id}&export=download`
        }));

        log(`Mensagens carregadas: ${messages.length}`);
    } catch (err) {
        log("Erro ao carregar mensagens: " + err.message);
        messages = [];
    }
}

async function startDriveJobs() {
    const auth = await authenticateGoogleDrive();
    await loadMessages(auth);
    setInterval(() => loadMessages(auth), 1800000);
}

// ------------------------- EXECUÇÃO DAS MENSAGENS -------------------------

function resumeStream() {
    io.emit("stop-mensagem");
    io.emit("play-stream", { url: "/stream", description: currentStream.description });
}

async function playRandomMessage() {
    if (isPlayingMessage || messages.length === 0) return;

    const msg = messages[Math.floor(Math.random() * messages.length)];
    isPlayingMessage = true;

    log("Mensagem aleatória: " + msg.name);
    io.emit("play-mensagem", msg);

    await new Promise(r => setTimeout(r, 60000));

    isPlayingMessage = false;
    resumeStream();
}

async function playSequentialMessages() {
    if (isPlayingMessage || messages.length === 0) return;

    blockRunning = true;
    previousStreamBeforeBlock = currentStream;
    isPlayingMessage = true;

    log("Iniciando bloco de mensagens das 11h");

    for (const msg of messages) {
        io.emit("play-mensagem", msg);
        await new Promise(r => setTimeout(r, 60000));
    }

    log("Fim bloco 11h");

    isPlayingMessage = false;
    blockRunning = false;

    currentStream = previousStreamBeforeBlock;
    resumeStream();
}

// --------------------- AGENDAMENTOS ---------------------

function schedule() {

    // MUSICA CLASSICA 00:10 → 05:00
    cron.schedule('10 0 * * *', () => {
        currentStream = STREAMS.classica;
        log("00:10 – Música Clássica");
        resumeStream();
    });

    // MENSAGENS A CADA 15 MIN DE MADRUGADA
    cron.schedule('*/15 0-4 * * *', () => {
        playRandomMessage();
    });

    // VOLTA IMACULADO 05:00
    cron.schedule('0 5 * * *', () => {
        currentStream = STREAMS.imaculado;
        log("05:00 – Volta Imaculado");
        resumeStream();
    });

    // BLOCO 11h → todas mensagens
    cron.schedule('0 11 * * *', () => {
        playSequentialMessages();
    });

    // FIM BLOCO 12h
    cron.schedule('0 12 * * *', () => {
        isPlayingMessage = false;
        currentStream = STREAMS.imaculado;
        log("12:00 – Fim bloco 11h");
        resumeStream();
    });

    // MARABA SÁB 12:50 → 13:05
    cron.schedule('50 12 * * 6', () => {
        currentStream = STREAMS.maraba;
        log("Sábado 12:50 – Informativo Paroquial");
        resumeStream();
    });

    cron.schedule('5 13 * * 6', () => {
        currentStream = STREAMS.imaculado;
        log("Sábado 13:05 – Fim informativo");
        resumeStream();
    });

    // DOMINGO MARABA 08:30 → 09:30
    cron.schedule('30 8 * * 0', () => {
        currentStream = STREAMS.maraba;
        log("Domingo 08:30 – Missa Marabá");
        resumeStream();
    });

    cron.schedule('30 9 * * 0', () => {
        currentStream = STREAMS.imaculado;
        log("Domingo 09:30 – Fim Missa Marabá");
        resumeStream();
    });

    // MISSA SÁBADO YOUTUBE 19h → 20:30
    cron.schedule('0 19 * * 6', () => {
        currentStream = STREAMS.missaYoutube;
        log("Sábado 19:00 – Missa pelo YouTube");
        resumeStream();
    });

    cron.schedule('30 20 * * 6', () => {
        currentStream = STREAMS.imaculado;
        log("Sábado 20:30 – Fim Missa YouTube");
        resumeStream();
    });

    log("Agendamentos carregados.");
}

// ------------------------ STREAM ------------------------

app.get('/stream', async (req, res) => {
    try {
        const url = currentStream.url;

        if (url.includes("youtube.com")) {
            try {
                const audioStream = ytdl(url, {
                    filter: "audioonly",
                    quality: "highestaudio",
                    highWaterMark: 1 << 25
                });

                exec("which ffmpeg", (err) => {
                    if (err) {
                        audioStream.pipe(res);
                        return;
                    }

                    const ff = spawn("ffmpeg", [
                        "-i", "pipe:0",
                        "-f", "mp3",
                        "-codec:a", "libmp3lame",
                        "-b:a", "128k",
                        "-ar", "44100",
                        "-ac", "2",
                        "pipe:1"
                    ]);

                    audioStream.pipe(ff.stdin);
                    ff.stdout.pipe(res);
                });

                return;
            } catch (err) {
                currentStream = STREAMS.imaculado;
                resumeStream();
                return;
            }
        }

        const target = new URL(url);
        const client = target.protocol === "https:" ? https : http;

        const reqStream = client.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: "GET",
            headers: { "User-Agent": "Mozilla", "Icy-MetaData": "0" }
        }, streamRes => {
            res.writeHead(200, {
                "Content-Type": "audio/mpeg",
                "Access-Control-Allow-Origin": "*"
            });
            streamRes.pipe(res);
        });

        reqStream.end();
    } catch {
        res.status(500).send("Erro geral no stream");
    }
});

// ------------------------ HEALTH ------------------------

app.get('/health', (req, res) => {
    res.json({
        status: "ok",
        currentStream: currentStream.description,
        messages: messages.length,
        hora: new Date().toLocaleString("pt-BR")
    });
});

// ------------------------ SOCKET.IO ------------------------

io.on("connection", socket => {
    socket.emit("play-stream", { url: "/stream", description: currentStream.description });
});

// ------------------------ START ------------------------

async function start() {
    server.listen(PORT, "0.0.0.0", () => {
        log("Servidor iniciado porta " + PORT);
    });

    setTimeout(async () => {
        await startDriveJobs();
        schedule();
    }, 1500);
}

start();
