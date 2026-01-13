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
    url: "https://stream.srg-ssr.ch/m/m/rsc_de/mp3_128", // Corrigido URL para o que você forneceu antes
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
    } catch (e) {
      // Ignora erros ao destruir, pois a conexão pode já ter sido fechada
    }
  }
  activeStreamResponses.clear();
  log("Conexões de stream ativas derrubadas.");
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
// Agendamentos de programação (horários em America/Sao_Paulo)
// Exemplo: Música Clássica às 00:10 BR (03:10 UTC)
cron.schedule(
  "10 0 * * *",
  () => {
    log("CRON: 00:10 BR – Iniciando Música Clássica");
    previousStream = currentStream;
    currentStream = STREAMS.classica;
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Exemplo: Fim Música Clássica às 01:10 BR (04:10 UTC), voltando para a rádio anterior
cron.schedule(
  "10 1 * * *",
  () => {
    log("CRON: 01:10 BR – Fim Música Clássica, voltando para rádio anterior");
    currentStream = previousStream; // Volta para o stream anterior
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Exemplo: Rádio Marabá às 07:00 BR (10:00 UTC)
cron.schedule(
  "0 7 * * *",
  () => {
    log("CRON: 07:00 BR – Iniciando Rádio Marabá");
    previousStream = currentStream;
    currentStream = STREAMS.maraba;
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Exemplo: Fim Rádio Marabá às 08:00 BR (11:00 UTC), voltando para a rádio anterior
cron.schedule(
  "0 8 * * *",
  () => {
    log("CRON: 08:00 BR – Fim Rádio Marabá, voltando para rádio anterior");
    currentStream = previousStream;
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Exemplo: Bloco de Mensagens Sequenciais às 12:00 BR (15:00 UTC)
cron.schedule(
  "0 12 * * *",
  () => {
    log("CRON: 12:00 BR – Iniciando Bloco de Mensagens Sequenciais");
    playSequentialMessages();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Exemplo: Mensagem Aleatória a cada 30 minutos (exceto durante blocos)
cron.schedule(
  "*/30 * * * *",
  () => {
    if (!blockRunning) {
      log("CRON: Mensagem Aleatória (a cada 30 min)");
      playRandomMessage();
    }
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Missa de Sábado às 19:00 BR (22:00 UTC)
cron.schedule(
  "0 19 * * 6", // Sábado
  () => {
    log("CRON: 19:00 BR (Sábado) – Iniciando Missa YouTube");
    previousStream = currentStream;
    currentStream = STREAMS.missaYoutube;
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Fim Missa de Sábado às 20:30 BR (23:30 UTC)
cron.schedule(
  "30 20 * * 6", // Sábado
  () => {
    log("CRON: 20:30 BR (Sábado) – Fim Missa Sábado, voltando para Voz do Coração Imaculado");
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Missa de Domingo às 08:00 BR (11:00 UTC)
cron.schedule(
  "0 8 * * 0", // Domingo
  () => {
    log("CRON: 08:00 BR (Domingo) – Iniciando Missa YouTube");
    previousStream = currentStream;
    currentStream = STREAMS.missaYoutube;
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

// Fim Missa de Domingo às 09:30 BR (12:30 UTC)
cron.schedule(
  "30 9 * * 0", // Domingo
  () => {
    log("CRON: 09:30 BR (Domingo) – Fim Missa Domingo, voltando para Voz do Coração Imaculado");
    currentStream = STREAMS.imaculado; // Volta para a rádio principal
    resumeStream();
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

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
}, {
    scheduled: true,
    timezone: TZ // Usar o fuso horário fixo para o cron de teste também
});
log("CRON DE TESTE (a cada minuto) carregado.");


// ---------------------- STREAM ----------------------

app.get("/stream", async (req, res) => {
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
