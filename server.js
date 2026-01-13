// server.js – Web Rádio Paróquia (CORRIGIDO: troca real de stream + TZ explícito + reconexão via cliente)

const express = require("express");
const http = require("http");
const https = require("https");
const socketIo = require("socket.io");
const cors = require("cors");
const cron = require("node-cron");
const { google } = require("googleapis");
const { spawn, exec } = require("child_process");
const ytdl = require("ytdl-core");
const path = require("path");
const { PassThrough } = require('stream'); // Importa PassThrough

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
// ---------------------- CONFIGURAÇÕES ----------------------
const TZ = "America/Sao_Paulo"; // FUSO HORÁRIO FIXO (BR)
const GOOGLE_DRIVE_FOLDER_ID = "1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2";
const YOUTUBE_MISSA_VIDEO_ID = "ZlXnuZcaJ2Y";
const STREAMS = {
  maraba: {
    url: "https://streaming.speedrs.com.br/radio/8010/maraba",
    description: "Rádio Marabá",
  },
  imaculado: {
    url: "http://r13.ciclano.io:9033/live",
    description: "Voz do Coração Imaculado",
  },
  classica: {
    url: "https://stream.srg-ssr.ch/m/rsc_de/mp3_128",
    description: "Música Clássica",
  },
  missaYoutube: {
    url: `https://www.youtube.com/watch?v=${YOUTUBE_MISSA_VIDEO_ID}`,
    description: "Missa de Sábado – YouTube",
  },
};
let currentStream = STREAMS.imaculado;
let previousStream = STREAMS.imaculado;
let messages = [];
let isPlayingMessage = false;
let blockRunning = false;
// Conexões ativas do endpoint /stream (PONTO-CHAVE para trocar programação)
const activeStreamResponses = new Set();
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
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
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
      pageSize: 500,
    });
    const files = resp.data.files || [];
    messages = files.map((f) => ({
      id: f.id,
      name: f.name,
      url: `https://drive.google.com/uc?id=${f.id}&export=download`,
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
  setInterval(() => loadMessages(auth), 30 * 60 * 1000); // 30 min
}
// ---------------------- TROCA DE STREAM (ESSENCIAL) ----------------------
function killActiveStreams() {
  // Derruba conexões antigas do /stream para forçar o player reconectar
  for (const res of activeStreamResponses) {
    try {
      res.destroy();
    } catch (e) {}
  }
  activeStreamResponses.clear();
}
function resumeStream() {
  // Troca REAL: mata streams ativos e manda o cliente reconectar
  killActiveStreams();
  io.emit("play-stream", {
    url: "/stream",
    description: currentStream.description,
  });
  log(`Retomando stream principal: ${currentStream.description}`);
}
function playMessage(messageUrl, messageName) {
  previousStream = currentStream; // Salva o stream atual antes de tocar a mensagem
  isPlayingMessage = true;
  io.emit("play-message", { url: messageUrl, description: messageName });
  log(`Reproduzindo mensagem: ${messageName}`);
}
function stopMessage() {
  isPlayingMessage = false;
  io.emit("stop-message");
  log("Mensagem finalizada. Retomando stream anterior.");
  currentStream = previousStream; // Volta para o stream que estava tocando antes da mensagem
  resumeStream();
}
// ---------------------- CRON JOBS (AGENDAMENTOS) ----------------------
log(`Agendamentos carregados (timezone fixo BR).`);

// CRON TESTE: Dispara a cada minuto para verificar o fuso horário e a atividade do cron
cron.schedule('* * * * *', () => {
    const serverTime = new Date();
    const serverTimeUTC = serverTime.toISOString();
    const serverTimeBR = serverTime.toLocaleString('pt-BR', { timeZone: TZ });
    log(`CRON TESTE: Disparado a cada minuto. Server UTC: ${serverTimeUTC}, Server BR (${TZ}): ${serverTimeBR}`);
}, {
    scheduled: true,
    timezone: TZ // Garante que o cron use o fuso horário BR para agendamento
});

// Exemplo: Trocar para Rádio Marabá às 00:00 BR (03:00 UTC)
cron.schedule('0 0 * * *', () => { // 00:00 BR
    if (!isPlayingMessage && !blockRunning) {
        currentStream = STREAMS.maraba;
        resumeStream();
        log(`CRON: 00:00 BR – Trocando para ${currentStream.description}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// Exemplo: Trocar para Voz do Coração Imaculado às 06:00 BR (09:00 UTC)
cron.schedule('0 6 * * *', () => { // 06:00 BR
    if (!isPlayingMessage && !blockRunning) {
        currentStream = STREAMS.imaculado;
        resumeStream();
        log(`CRON: 06:00 BR – Trocando para ${currentStream.description}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// Exemplo: Tocar uma mensagem aleatória às 10:00 BR (13:00 UTC)
cron.schedule('0 10 * * *', () => { // 10:00 BR
    if (messages.length > 0 && !isPlayingMessage && !blockRunning) {
        const randomIndex = Math.floor(Math.random() * messages.length);
        const message = messages[randomIndex];
        playMessage(message.url, message.name);
        // A função playMessage já lida com o retorno ao stream anterior via evento 'ended' no cliente
        log(`CRON: 10:00 BR – Tocando mensagem: ${message.name}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// Exemplo: Trocar para Música Clássica às 14:00 BR (17:00 UTC)
cron.schedule('0 14 * * *', () => { // 14:00 BR
    if (!isPlayingMessage && !blockRunning) {
        currentStream = STREAMS.classica;
        resumeStream();
        log(`CRON: 14:00 BR – Trocando para ${currentStream.description}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// Exemplo: Missa de Sábado (YouTube) às 19:00 BR (22:00 UTC) - Sábados
cron.schedule('0 19 * * 6', () => { // 19:00 BR, apenas aos sábados (6)
    if (!isPlayingMessage && !blockRunning) {
        currentStream = STREAMS.missaYoutube;
        resumeStream();
        log(`CRON: 19:00 BR (Sábado) – Trocando para ${currentStream.description}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// Exemplo: Retornar para Voz do Coração Imaculado após a Missa de Sábado às 21:00 BR (00:00 UTC do domingo) - Sábados
cron.schedule('0 21 * * 6', () => { // 21:00 BR, apenas aos sábados (6)
    if (!isPlayingMessage && !blockRunning) { // Verifica se não está tocando mensagem
        currentStream = STREAMS.imaculado;
        resumeStream();
        log(`CRON: 21:00 BR (Sábado) – Retornando para ${currentStream.description}`);
    }
}, {
    scheduled: true,
    timezone: TZ
});

// ---------------------- ENDPOINT DE STREAM ----------------------
app.get("/stream", (req, res) => {
  // Adiciona a resposta atual ao conjunto de respostas ativas
  activeStreamResponses.add(res);

  // Remove a resposta do conjunto quando a conexão é fechada
  req.on("close", () => {
    activeStreamResponses.delete(res);
    // log("Conexão de stream fechada."); // Opcional: logar fechamento
  });

  try {
    const url = currentStream.url;

    if (url.includes("youtube.com")) {
      try {
        const ytStream = ytdl(url, {
          filter: "audioonly",
          quality: "highestaudio",
          highWaterMark: 1 << 25,
        });
        exec("which ffmpeg", (err) => {
          // Se não tiver ffmpeg, manda direto (pode funcionar em alguns players, mas nem sempre)
          if (err) {
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            ytStream.pipe(res);
            return;
          }
          const ff = spawn("ffmpeg", [
            "-i",
            "pipe:0",
            "-f",
            "mp3",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "pipe:1",
          ]);
          ytStream.pipe(ff.stdin);
          res.writeHead(200, { "Content-Type": "audio/mpeg" });
          ff.stdout.pipe(res);
          ff.on("error", (e) => {
            log("FFmpeg erro: " + e.message);
          });
          ff.on("close", () => {
            try {
              ytStream.destroy();
            } catch (e) {}
          });
        });
        return;
      } catch (err) {
        log(`Erro YouTube: ${err.message}. Voltando para Imaculado.`);
        currentStream = STREAMS.imaculado;
        resumeStream();
        res.status(500).end("Erro ao processar YouTube.");
        return;
      }
    }
    // Proxy normal (http/https)
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;

    // Cria um PassThrough stream para bufferização
    const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer

    const upstreamReq = client.request(
      {
        hostname: target.hostname,
        port:
          target.port ||
          (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          // "Icy-MetaData": "1", // REMOVIDO PARA TESTE
          // Connection: "keep-alive", // REMOVIDO PARA TESTE
        },
      },
      (streamRes) => {
        // Copia os headers da resposta original para o cliente
        Object.keys(streamRes.headers).forEach(key => {
            if (key.toLowerCase() !== 'transfer-encoding') { // Evita problemas com transfer-encoding
                res.setHeader(key, streamRes.headers[key]);
            }
        });
        res.writeHead(streamRes.statusCode, { "Content-Type": "audio/mpeg" }); // Garante Content-Type correto

        streamRes.pipe(passthrough).pipe(res); // Pipe através do PassThrough

        streamRes.on("error", (e) => {
          log("Erro streamRes (upstream): " + e.message);
          passthrough.destroy(e); // Destrói o passthrough em caso de erro
        });
        passthrough.on("error", (e) => { // Adicionado tratamento de erro para o passthrough
            log("Erro passthrough: " + e.message);
            try { res.end(); } catch (err) {}
        });
        streamRes.on("close", () => {
            log("Stream upstream fechado.");
        });
      }
    );
    upstreamReq.on("error", (e) => {
      log(`Erro no proxy do stream (upstreamReq): ${e.message}`);
      try {
        res.status(500).end("Erro ao carregar stream.");
      } catch (err) {}
    });
    upstreamReq.end();
  } catch (err) {
    log(`Erro geral no /stream: ${err.message}`);
    try {
      res.status(500).end("Erro stream");
    } catch (e) {}
  }
});
// ---------------------- HEALTH ----------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    currentStream: currentStream.description,
    mensagensCarregadas: messages.length,
    serverTimeISO: new Date().toISOString(),
    tz: TZ,
    activeStreamConnections: activeStreamResponses.size,
    isPlayingMessage,
    blockRunning,
  });
});
// ---------------------- SOCKET.IO ----------------------
io.on("connection", (socket) => {
  // Ao conectar, manda tocar o stream atual
  socket.emit("play-stream", {
    url: "/stream",
    description: currentStream.description,
  });
  // (Opcional) ping
  socket.on("ping", () => socket.emit("pong"));
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
