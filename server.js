// server.js – Web Rádio Paróquia (versão sem timezone, usando horário UTC do servidor)

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

const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.static("public"));

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
let previousStream = STREAMS.imaculado;
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
    const auth = await authenticateDrive();
    await loadMessages(auth);
    setInterval(() => loadMessages(auth), 1800000);
}

// ---------------------- ÁUDIO / MENSAGENS ----------------------

function resumeStream() {
    io.emit("stop-mensagem");
    io.emit("play-stream", {
        url: "/stream",
        description: currentStream.description
    });
}

async function playRandomMessage() {
    if (isPlayingMessage || messages.length === 0) return;

    const msg = messages[Math.floor(Math.random() * messages.length)];

    isPlayingMessage = true;
    io.emit("play-mensagem", msg);

    log("Mensagem aleatória: " + msg.name);

    await new Promise(r => setTimeout(r, 60000));

    isPlayingMessage = false;
    resumeStream();
}

async function playSequentialMessages() {
    if (isPlayingMessage || messages.length === 0) return;

    blockRunning = true;
    previousStream = currentStream;
    isPlayingMessage = true;

    log("Início do bloco 11h (UTC 14h)");

    for (const msg of messages) {
        io.emit("play-mensagem", msg);
        await new Promise(r => setTimeout(r, 60000));
    }

    log("Fim bloco 11h");

    isPlayingMessage = false;
    blockRunning = false;

    currentStream = previousStream;
    resumeStream();
}

// ---------------------- AGENDAMENTOS (UTC) ----------------------
// Servidor UTC = Brasil + 3h

// Clássica 00:10 BR = 03:10 UTC
cron.schedule("10 3 * * *", () => {
    currentStream = STREAMS.classica;
    log("03:10 UTC – Música Clássica");
    resumeStream();
});

// Mensagens madrugada → 03h–07h UTC
cron.schedule("*/15 3-7 * * *", () => {
    playRandomMessage();
});

// Volta Imaculado 05:00 BR = 08:00 UTC
cron.schedule("0 8 * * *", () => {
    currentStream = STREAMS.imaculado;
    log("08:00 UTC – Volta Imaculado");
    resumeStream();
});

// Bloco diário 11h BR = 14h UTC
cron.schedule("0 14 * * *", () => {
    playSequentialMessages();
});

// Fim bloco 12h BR = 15h UTC
cron.schedule("0 15 * * *", () => {
    currentStream = STREAMS.imaculado;
    isPlayingMessage = false;
    blockRunning = false;
    log("15:00 UTC – Fim Bloco 11h");
    resumeStream();
});

// Sábado Informativo 12:50 BR = 15:50 UTC
cron.schedule("50 15 * * 6", () => {
    currentStream = STREAMS.maraba;
    log("15:50 UTC – Informativo Paroquial");
    resumeStream();
});

// Sábado volta 13:05 BR = 16:05 UTC
cron.schedule("5 16 * * 6", () => {
    currentStream = STREAMS.imaculado;
    log("16:05 UTC – Fim Informativo");
    resumeStream();
});

// Domingo 08:30 BR = 11:30 UTC
cron.schedule("30 11 * * 0", () => {
    currentStream = STREAMS.maraba;
    log("11:30 UTC – Missa Domingo Marabá");
    resumeStream();
});

// Domingo volta 09:30 BR = 12:30 UTC
cron.schedule("30 12 * * 0", () => {
    currentStream = STREAMS.imaculado;
    log("12:30 UTC – Fim Missa Domingo Marabá");
    resumeStream();
});

// Sábado Missa 19:00 BR = 22:00 UTC
cron.schedule("0 22 * * 6", () => {
    currentStream = STREAMS.missaYoutube;
    log("22:00 UTC – Missa Sábado YouTube");
    resumeStream();
});

// Volta 20:30 BR = 23:30 UTC
cron.schedule("30 23 * * 6", () => {
    currentStream = STREAMS.imaculado;
    log("23:30 UTC – Fim Missa Sábado");
    resumeStream();
});

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
                currentStream = STREAMS.imaculado;
                resumeStream();
                return;
            }
        }

        const target = new URL(url);
        const client = target.protocol === "https:" ? https : http;

        const reqS = client.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: "GET",
            headers: { "User-Agent": "Mozilla" }
        }, streamRes => {
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            streamRes.pipe(res);
        });

        reqS.end();

    } catch (err) {
        res.status(500).send("Erro stream");
    }
});

// ---------------------- HEALTH ----------------------

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        currentStream: currentStream.description,
        mensagens: messages.length,
        serverTimeUTC: new Date().toISOString()
    });
});

// ---------------------- SOCKET.IO ----------------------

io.on("connection", socket => {
    socket.emit("play-stream", {
        url: "/stream",
        description: currentStream.description
    });
});

// ---------------------- START ----------------------

async function start() {
    server.listen(PORT, "0.0.0.0", () => {
        log("Servidor iniciado.");
    });

    setTimeout(async () => {
        await startDrive();
    }, 1500);
}

start();
