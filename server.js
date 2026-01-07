// server.js – Web Rádio Paróquia (CÓDIGO ORIGINAL COM CORREÇÕES ESSENCIAIS E LÓGICA DE RETORNO À RÁDIO PRINCIPAL)

const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const cors = require('cors');
const cron = require('node-cron');
const { google } = require('googleapis');
const { spawn, exec } = require('child_process');
const ytdl = require('ytdl-core');
const path = require('path'); // Adicionado para servir arquivos estáticos

const app = express();
const server = http.createServer(app);

const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
// Serve arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------- CONFIGURAÇÕES ----------------------

const GOOGLE_DRIVE_FOLDER_ID = "1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2";
const YOUTUBE_MISSA_VIDEO_ID = "ZlXnuZcaJ2Y";

const STREAMS = {
    maraba: {
        url: "https://streaming.speedrs.com.br/radio/8010/maraba",
        description: "Rádio Marabá"
    },
    imaculado: {
        url: "http://r13.ciclano.io:9033/live",
        description: "Voz do Coração Imaculado"
    },
    classica: {
        url: "https://stream.srg-ssr.ch/m/rsc_de/mp3_128",
        description: "Música Clássica"
    },
    missaYoutube: {
        url: `https://www.youtube.com/watch?v=${YOUTUBE_MISSA_VIDEO_ID}`,
        description: "Missa de Sábado – YouTube"
    }
};

let currentStream = STREAMS.imaculado;
let messages = [];
let isPlayingMessage = false;
let previousStream = STREAMS.imaculado; // Inicializa com a rádio principal
let blockRunning = false;

// ---------------------- LOG ----------------------

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------- GOOGLE DRIVE ----------------------

async function authenticateDrive() {
    try {
        const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        if (!json) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON ausente");

        const creds = JSON.parse(json);
        const auth = new google.auth.GoogleAuth({
            credentials: creds,
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });

        log("Google Drive autenticado.");
        return auth;

    } catch (err) {
        log("Erro Drive: " + err.message);
        return null;
    }
}

async function loadMessages(auth) {
    try {
        if (!auth) return;

        const drive = google.drive({ version: "v3", auth });

        const resp = await drive.files.list({
            q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType contains 'audio'`,
            fields: "files(id,name)",
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
        log("Erro carregando mensagens: " + err.message);
        messages = [];
    }
}

async function startDrive() {
    log("Iniciando carregamento de mensagens do Google Drive...");
    const auth = await authenticateDrive();
    await loadMessages(auth);
    setInterval(() => loadMessages(auth), 1800000); // Recarrega mensagens a cada 30 minutos
}

// ---------------------- ÁUDIO / MENSAGENS ----------------------

function resumeStream() {
    io.emit("stop-mensagem");
    io.emit("play-stream", {
        url: "/stream",
        description: currentStream.description
    });
    // Força uma reconexão do Socket.IO para garantir que o player atualize
    io.emit("force-reconnect");
    log(`Stream atualizado para: ${currentStream.description}`);
}

async function playRandomMessage() {
    if (isPlayingMessage || messages.length === 0) return;

    // Salva o stream atual antes de tocar a mensagem
    previousStream = currentStream;

    const msg = messages[Math.floor(Math.random() * messages.length)];

    isPlayingMessage = true;
    io.emit("play-mensagem", msg);

    log("Mensagem aleatória: " + msg.name);

    // Duração da mensagem (1 minuto)
    await new Promise(r => setTimeout(r, 60000));

    isPlayingMessage = false;
    // Retorna ao stream anterior (que deve ser a Imaculada, a menos que outra programação estivesse ativa)
    currentStream = previousStream; 
    resumeStream();
}

async function playSequentialMessages() {
    if (isPlayingMessage || messages.length === 0) return;

    blockRunning = true;
    previousStream = currentStream; // Salva o stream anterior
    isPlayingMessage = true;

    log("Início do bloco de mensagens sequenciais (11h BR / 14h UTC)");

    for (const msg of messages) {
        io.emit("play-mensagem", msg);
        log(`Reproduzindo mensagem sequencial: ${msg.name}`);
        // Duração da mensagem (1 minuto)
        await new Promise(r => setTimeout(r, 60000));
    }

    log("Fim do bloco de mensagens sequenciais");

    isPlayingMessage = false;
    blockRunning = false;

    // Retorna ao stream anterior (que deve ser a Imaculada, a menos que outra programação estivesse ativa)
    currentStream = previousStream; 
    resumeStream();
}

// ---------------------- AGENDAMENTOS (UTC - Brasil +3h) ----------------------
// Os horários abaixo são em UTC. Para converter de BR para UTC, some 3 horas.

// Exemplo: 00:10 BR = 03:10 UTC
cron.schedule("10 3 * * *", () => {
    previousStream = currentStream; // Salva o stream atual
    currentStream = STREAMS.classica;
    log("CRON: 03:10 UTC (00:10 BR) – Iniciando Música Clássica");
    resumeStream();
});

// Mensagens aleatórias na madrugada (03h-07h UTC = 00h-04h BR)
cron.schedule("*/15 3-7 * * *", () => {
    log("CRON: Disparando mensagem aleatória (00h-04h BR)");
    playRandomMessage(); // playRandomMessage já salva e restaura previousStream
});

// Volta Imaculado 05:00 BR = 08:00 UTC
cron.schedule("0 8 * * *", () => {
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    log("CRON: 08:00 UTC (05:00 BR) – Voltando para Voz do Coração Imaculado");
    resumeStream();
});

// Bloco diário de mensagens sequenciais 11h BR = 14h UTC
cron.schedule("0 14 * * *", () => {
    log("CRON: 14:00 UTC (11:00 BR) – Iniciando Bloco de Mensagens Sequenciais");
    playSequentialMessages(); // playSequentialMessages já salva e restaura previousStream
});

// Fim do bloco de mensagens 12h BR = 15h UTC
cron.schedule("0 15 * * *", () => {
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    isPlayingMessage = false;
    blockRunning = false;
    log("CRON: 15:00 UTC (12:00 BR) – Fim do Bloco de Mensagens Sequenciais");
    resumeStream();
});

// Sábado Informativo 12:50 BR = 15:50 UTC
cron.schedule("50 15 * * 6", () => {
    previousStream = currentStream; // Salva o stream atual
    currentStream = STREAMS.maraba;
    log("CRON: 15:50 UTC (12:50 BR) – Iniciando Informativo Paroquial (Rádio Marabá)");
    resumeStream();
});

// Sábado volta Imaculado 13:05 BR = 16:05 UTC
cron.schedule("5 16 * * 6", () => {
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    log("CRON: 16:05 UTC (13:05 BR) – Fim Informativo, voltando para Voz do Coração Imaculado");
    resumeStream();
});

// Domingo Missa 08:30 BR = 11:30 UTC
cron.schedule("30 11 * * 0", () => {
    previousStream = currentStream; // Salva o stream atual
    currentStream = STREAMS.maraba; // Usando Marabá como exemplo para Missa Domingo
    log("CRON: 11:30 UTC (08:30 BR) – Iniciando Missa Domingo (Rádio Marabá)");
    resumeStream();
});

// Domingo volta Imaculado 09:30 BR = 12:30 UTC
cron.schedule("30 12 * * 0", () => {
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    log("CRON: 12:30 UTC (09:30 BR) – Fim Missa Domingo, voltando para Voz do Coração Imaculado");
    resumeStream();
});

// Sábado Missa YouTube 19:00 BR = 22:00 UTC
cron.schedule("0 22 * * 6", () => {
    previousStream = currentStream; // Salva o stream atual
    currentStream = STREAMS.missaYoutube;
    log("CRON: 22:00 UTC (19:00 BR) – Iniciando Missa de Sábado (YouTube)");
    resumeStream();
});

// Sábado volta Imaculado 20:30 BR = 23:30 UTC
cron.schedule("30 23 * * 6", () => {
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    log("CRON: 23:30 UTC (20:30 BR) – Fim Missa Sábado, voltando para Voz do Coração Imaculado");
    resumeStream();
});

log("Agendamentos de programação carregados.");

// ---------------------- CRON DE TESTE (A CADA MINUTO) ----------------------
// Este cron será removido após a depuração.
cron.schedule('* * * * *', () => {
    const serverTime = new Date();
    log(`CRON TESTE: Disparado a cada minuto. Hora do servidor (UTC): ${serverTime.toISOString()}`);
    log(`CRON TESTE: Fuso horário do servidor: ${serverTime.toString().match(/|
$
([^)]+)
$
|/)[1] || 'Não detectado'}`);
});
log("CRON DE TESTE (a cada minuto) carregado.");


// ---------------------- STREAM ----------------------

app.get("/stream", async (req, res) => {
    try {
        const url = currentStream.url;

        if (url.includes("youtube.com")) {
            try {
                const stream = ytdl(url, {
                    filter: "audioonly",
                    quality: "highestaudio",
                    highWaterMark: 1 << 25
                });

                exec("which ffmpeg", err => {
                    if (err) {
                        stream.pipe(res);
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

                    stream.pipe(ff.stdin);
                    ff.stdout.pipe(res);
                });

                return;

            } catch (err) {
                log(`Erro ao processar YouTube stream: ${err.message}. Voltando para Imaculado.`);
                currentStream = STREAMS.imaculado;
                resumeStream();
                return;
            }
        }

        const target = new URL(url);
        const client = target.protocol === "https:" ? https : http;

        const reqS = client.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === "https:" ? 443 : 80), // Adicionado para HTTPS
            path: target.pathname + target.search,
            method: "GET",
            headers: { "User-Agent": "Mozilla" }
        }, streamRes => {
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            streamRes.pipe(res);
        });

        reqS.on('error', (e) => {
            log(`Erro na requisição do stream: ${e.message}`);
            res.status(500).send("Erro ao carregar stream.");
        });

        reqS.end();

    } catch (err) {
        log(`Erro geral no /stream: ${err.message}.`);
        res.status(500).send("Erro stream");
    }
});

// ---------------------- HEALTH ----------------------

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        currentStream: currentStream.description,
        mensagensCarregadas: messages.length,
        serverTimeUTC: new Date().toISOString()
    });
});

// ---------------------- SOCKET.IO ----------------------

io.on("connection", socket => {
    socket.emit("play-stream", {
        url: "/stream",
        description: currentStream.description
    });

    // Listener para forçar reconexão do player
    socket.on("force-reconnect", () => {
        log("Recebido comando para forçar reconexão do player via Socket.IO.");
        socket.emit("play-stream", {
            url: "/stream",
            description: currentStream.description
        });
    });
});

// ---------------------- START ----------------------

async function start() {
    server.listen(PORT, "0.0.0.0", () => {
        log(`Servidor iniciado na porta ${PORT}.`);
    });

    setTimeout(async () => {
        await startDrive();
    }, 1500);
}

start();
