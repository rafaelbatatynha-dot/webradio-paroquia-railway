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

  io.emit("stop-mensagem");
  io.emit("play-stream", {
    url: "/stream",
    description: currentStream.description,
  });

  log(`Stream atualizado para: ${currentStream.description}`);
}

// ---------------------- MENSAGENS ----------------------

async function playRandomMessage() {
  if (isPlayingMessage || messages.length === 0 || blockRunning) return;

  previousStream = currentStream;

  const msg = messages[Math.floor(Math.random() * messages.length)];
  isPlayingMessage = true;

  log("Mensagem aleatória: " + msg.name);
  io.emit("play-mensagem", msg);

  // Se você souber a duração real do áudio, o ideal é calcular. Aqui mantemos 60s.
  await new Promise((r) => setTimeout(r, 60000));

  isPlayingMessage = false;
  currentStream = previousStream;
  resumeStream();
}

async function playSequentialMessages() {
  if (isPlayingMessage || messages.length === 0) return;

  blockRunning = true;
  previousStream = currentStream;
  isPlayingMessage = true;

  log("Início do bloco de mensagens sequenciais");

  for (const msg of messages) {
    io.emit("play-mensagem", msg);
    log(`Reproduzindo mensagem: ${msg.name}`);
    await new Promise((r) => setTimeout(r, 60000));
  }

  log("Fim do bloco de mensagens sequenciais");

  isPlayingMessage = false;
  blockRunning = false;

  currentStream = previousStream;
  resumeStream();
}

// ---------------------- AGENDAMENTOS (HORÁRIOS EM BR) ----------------------
// Agora você escreve em horário BR direto, porque o timezone do cron é fixo em America/Sao_Paulo

// Música clássica 00:10 BR
cron.schedule(
  "10 0 * * *",
  () => {
    previousStream = currentStream;
    currentStream = STREAMS.classica;
    log("CRON: 00:10 BR – Iniciando Música Clássica");
    resumeStream();
  },
  { timezone: TZ }
);

// Mensagens aleatórias 00:00–04:59 BR a cada 15 minutos
cron.schedule(
  "*/15 0-4 * * *",
  () => {
    log("CRON: Mensagem aleatória (00h-04h BR)");
    playRandomMessage();
  },
  { timezone: TZ }
);

// Volta Imaculado 05:00 BR
cron.schedule(
  "0 5 * * *",
  () => {
    currentStream = STREAMS.imaculado;
    log("CRON: 05:00 BR – Voltando para Voz do Coração Imaculado");
    resumeStream();
  },
  { timezone: TZ }
);

// Bloco diário mensagens 11:00 BR
cron.schedule(
  "0 11 * * *",
  () => {
    log("CRON: 11:00 BR – Iniciando Bloco de Mensagens Sequenciais");
    playSequentialMessages();
  },
  { timezone: TZ }
);

// Fim do bloco 12:00 BR (garantia)
cron.schedule(
  "0 12 * * *",
  () => {
    currentStream = STREAMS.imaculado;
    isPlayingMessage = false;
    blockRunning = false;
    log("CRON: 12:00 BR – Fim do Bloco de Mensagens, voltando para Imaculado");
    resumeStream();
  },
  { timezone: TZ }
);

// Sábado Informativo 12:50 BR
cron.schedule(
  "50 12 * * 6",
  () => {
    previousStream = currentStream;
    currentStream = STREAMS.maraba;
    log("CRON: Sábado 12:50 BR – Informativo Paroquial (Rádio Marabá)");
    resumeStream();
  },
  { timezone: TZ }
);

// Sábado volta 13:05 BR
cron.schedule(
  "5 13 * * 6",
  () => {
    currentStream = STREAMS.imaculado;
    log("CRON: Sábado 13:05 BR – Voltando para Imaculado");
    resumeStream();
  },
  { timezone: TZ }
);

// Domingo Missa 08:30 BR (exemplo: Marabá)
cron.schedule(
  "30 8 * * 0",
  () => {
    previousStream = currentStream;
    currentStream = STREAMS.maraba;
    log("CRON: Domingo 08:30 BR – Missa (Rádio Marabá)");
    resumeStream();
  },
  { timezone: TZ }
);

// Domingo volta 09:30 BR
cron.schedule(
  "30 9 * * 0",
  () => {
    currentStream = STREAMS.imaculado;
    log("CRON: Domingo 09:30 BR – Voltando para Imaculado");
    resumeStream();
  },
  { timezone: TZ }
);

// Sábado Missa YouTube 19:00 BR
cron.schedule(
  "0 19 * * 6",
  () => {
    previousStream = currentStream;
    currentStream = STREAMS.missaYoutube;
    log("CRON: Sábado 19:00 BR – Missa no YouTube");
    resumeStream();
  },
  { timezone: TZ }
);

// Sábado volta 20:30 BR
cron.schedule(
  "30 20 * * 6",
  () => {
    currentStream = STREAMS.imaculado;
    log("CRON: Sábado 20:30 BR – Voltando para Imaculado");
    resumeStream();
  },
  { timezone: TZ }
);

log("Agendamentos carregados (timezone fixo BR).");

// ---------------------- STREAM ----------------------

app.get("/stream", async (req, res) => {
  // Registra conexão ativa
  activeStreamResponses.add(res);

  res.on("close", () => {
    activeStreamResponses.delete(res);
  });

  // Evita cache
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  try {
    const url = currentStream.url;

    // YouTube -> áudio
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
          "Icy-MetaData": "1",
          Connection: "keep-alive",
        },
      },
      (streamRes) => {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        streamRes.pipe(res);

        streamRes.on("error", (e) => {
          log("Erro streamRes: " + e.message);
        });
      }
    );

    upstreamReq.on("error", (e) => {
      log(`Erro no proxy do stream: ${e.message}`);
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
