// server.js – Web Rádio Paróquia (CORRIGIDO: detecção de fim de mensagem no cliente + TZ explícito + reconexão via cliente)

const express = require("express");
const http = require("http"); // Usar http para o servidor principal
const https = require("https"); // Usar https para requisições externas (Google Drive, streams)
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
let blockRunning = false; // Bloqueia a execução de múltiplos blocos de programação
// Conexões ativas do endpoint /stream (PONTO-CHAVE para trocar programação)
const activeStreamResponses = new Set();
// Cache para mensagens do Google Drive
const messageCache = new Map(); // Map<fileId, { buffer: Buffer, contentType: string, contentLength: number }>
// ---------------------- LOG ----------------------
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
// ---------------------- GOOGLE DRIVE ----------------------
let driveAuth = null; // Variável para armazenar a autenticação do Drive
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
    driveAuth = auth; // Armazena a autenticação para uso posterior
    const drive = google.drive({ version: "v3", auth });
    const resp = await drive.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType contains 'audio'`,
      fields: "files(id,name,mimeType)", // Pedir mimeType
      pageSize: 500,
    });
    const files = resp.data.files || [];
    messages = files.map((f) => ({
      id: f.id,
      name: f.name,
      // A URL agora aponta para um endpoint interno que servirá o buffer
      url: `/message-stream/${f.id}`,
      mimeType: f.mimeType || 'audio/mpeg', // Garante um mimeType padrão
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
  setInterval(() => loadMessages(auth), 30 * 60 * 1000); // Recarrega a cada 30 min
}
// ---------------------- FUNÇÕES DE STREAM ----------------------
function killActiveStreams() {
  // Derruba conexões antigas do /stream para forçar o player reconectar
  for (const res of activeStreamResponses) {
    try {
      res.destroy();
    } catch (e) {}
  }
  activeStreamResponses.clear();
}
function changeStream(newStream) {
  if (currentStream.url === newStream.url && !isPlayingMessage) {
    log(`Stream já é ${newStream.description}. Nenhuma mudança necessária.`);
    return;
  }
  previousStream = currentStream; // Salva o stream atual como anterior
  currentStream = newStream;
  log(`Trocando stream para: ${currentStream.description}`);
  // Troca REAL: mata streams ativos e manda o cliente reconectar
  killActiveStreams();
  io.emit("play-stream", {
    url: "/stream",
    description: currentStream.description,
  });
}
function playMessage(messageUrlOrId, messageName) {
  if (isPlayingMessage) {
    log("Já está tocando uma mensagem. Ignorando novo comando.");
    return;
  }
  isPlayingMessage = true;
  log(`Iniciando reprodução de mensagem: ${messageName}`);
  // Salva o stream atual para retornar a ele depois
  previousStream = currentStream;
  // Troca REAL: mata streams ativos e manda o cliente tocar a mensagem
  killActiveStreams();
  io.emit("play-message", {
    url: messageUrlOrId, // Pode ser a URL direta ou o ID para o endpoint interno
    description: messageName,
  });
  // >>>>> REMOVIDO: setTimeout fixo para voltar ao stream anterior <<<<<
  // A lógica de retorno será tratada pelo cliente via evento 'message-ended'
}
function stopMessageAndResumePrevious() {
  if (!isPlayingMessage) return;
  isPlayingMessage = false;
  log(`Mensagem finalizada. Retomando stream: ${previousStream.description}`);
  // Retoma o stream anterior
  currentStream = previousStream; // Garante que currentStream seja o anterior
  killActiveStreams();
  io.emit("play-stream", {
    url: "/stream",
    description: currentStream.description,
  });
  io.emit("stop-message"); // Notifica o cliente que a mensagem parou
}
// ---------------------- AGENDAMENTO (CRON) ----------------------
// Teste de CRON a cada minuto (apenas para depuração)
cron.schedule("* * * * *", () => {
  const now = new Date();
  log(`CRON TESTE: Disparado a cada minuto. UTC: ${now.toISOString()} | BR: ${now.toLocaleString("pt-BR", { timeZone: TZ })}`);
}, { scheduled: true, timezone: TZ });

// Exemplo de agendamento: Rádio Imaculado das 6h às 19h
cron.schedule("0 6 * * *", () => changeStream(STREAMS.imaculado), { scheduled: true, timezone: TZ });
cron.schedule("0 19 * * *", () => changeStream(STREAMS.maraba), { scheduled: true, timezone: TZ });

// Exemplo de agendamento: Missa de Sábado às 19h
cron.schedule("0 19 * * 6", () => changeStream(STREAMS.missaYoutube), { scheduled: true, timezone: TZ });
cron.schedule("30 20 * * 6", () => changeStream(STREAMS.maraba), { scheduled: true, timezone: TZ }); // Volta para Marabá 20:30

// Exemplo de agendamento: Missa de Domingo às 9h
cron.schedule("0 9 * * 0", () => changeStream(STREAMS.missaYoutube), { scheduled: true, timezone: TZ });
cron.schedule("30 10 * * 0", () => changeStream(STREAMS.maraba), { scheduled: true, timezone: TZ }); // Volta para Marabá 10:30

// Agendamento para tocar uma mensagem aleatória a cada 15 minutos (exemplo)
cron.schedule('*/15 * * * *', () => {
    if (messages.length > 0 && !isPlayingMessage) {
        const randomIndex = Math.floor(Math.random() * messages.length);
        const message = messages[randomIndex];
        log(`Agendamento: Tocando mensagem aleatória: ${message.name}.`);
        playMessage(`/message-stream/${message.id}`, message.name);
        // >>>>> REMOVIDO: setTimeout fixo aqui também <<<<<
        // A lógica de retorno será tratada pelo cliente via evento 'message-ended'
    } else if (messages.length === 0) {
        log('Agendamento: Nenhuma mensagem disponível para tocar.');
    } else {
        log('Agendamento: Mensagem já está tocando, pulando este agendamento.');
    }
}, {
  scheduled: true,
  timezone: TZ,
});

// ---------------------- ENDPOINTS HTTP ----------------------

// Novo endpoint para servir mensagens do Google Drive a partir do buffer
app.get("/message-stream/:fileId", async (req, res) => {
  const fileId = req.params.fileId;
  // Tenta servir do cache primeiro
  if (messageCache.has(fileId)) {
    const cached = messageCache.get(fileId);
    log(`Servindo mensagem ${fileId} do cache.`);
    res.writeHead(200, {
      "Content-Type": cached.contentType,
      "Content-Length": cached.contentLength,
      "Cache-Control": "public, max-age=3600", // Cache por 1 hora
    });
    return res.end(cached.buffer);
  }

  // Se não estiver no cache, baixa do Google Drive
  try {
    if (!driveAuth) {
      log("Erro: Google Drive não autenticado ao tentar baixar mensagem.");
      return res.status(500).send("Serviço de mensagens indisponível.");
    }
    const drive = google.drive({ version: "v3", auth: driveAuth });
    const response = await drive.files.get(
      { fileId: fileId, alt: "media" },
      { responseType: "stream" }
    );

    const chunks = [];
    let contentLength = 0;
    let contentType = 'audio/mpeg'; // Padrão

    response.data.on('data', chunk => {
      chunks.push(chunk);
      contentLength += chunk.length;
    });

    response.data.on('end', () => {
      const buffer = Buffer.concat(chunks);
      // Tenta obter o Content-Type da resposta do Drive, se disponível
      if (response.headers && response.headers['content-type']) {
          contentType = response.headers['content-type'];
      }

      // Armazena no cache
      messageCache.set(fileId, { buffer, contentType, contentLength });
      log(`Mensagem ${fileId} baixada e armazenada em cache. Tamanho: ${contentLength} bytes.`);

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": contentLength,
        "Cache-Control": "public, max-age=3600", // Cache por 1 hora
      });
      res.end(buffer);
    });

    response.data.on('error', (err) => {
      log(`Erro ao baixar mensagem ${fileId} do Google Drive: ${err.message}`);
      res.status(500).send("Erro ao carregar mensagem.");
    });

  } catch (err) {
    log(`Erro geral ao servir /message-stream/${fileId}: ${err.message}`);
    res.status(500).send("Erro ao carregar mensagem.");
  }
});


// Endpoint principal para streaming de rádio
app.get("/stream", async (req, res) => {
  activeStreamResponses.add(res);
  res.on("close", () => activeStreamResponses.delete(res));

  try {
    const url = currentStream.url;

    // Se for YouTube, usa ytdl-core
    if (url.includes("youtube.com")) {
      const videoId = ytdl.getURLVideoID(url);
      const youtubeStream = ytdl(videoId, {
        quality: "highestaudio",
        filter: "audioonly",
      });

      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      youtubeStream.pipe(res);

      youtubeStream.on("error", (e) => {
        log("Erro YouTube stream: " + e.message);
        res.status(500).send("Erro ao carregar stream do YouTube.");
      });
    } else {
      // Para streams diretos (Marabá, Imaculado, Clássica)
      const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer
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
              log("Erro passthrough (Direto): " + e.message);
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
    }
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
  // Listener para trocar o stream via Socket.IO (para os botões de teste)
  socket.on('change-stream', (streamKey) => {
      const newStream = STREAMS[streamKey];
      if (newStream) {
          log(`Recebido comando para mudar stream para: ${newStream.description} via Socket.IO.`);
          changeStream(newStream); // Usa a função existente para mudar o stream
      } else {
          log(`Erro: Stream key '${streamKey}' inválida recebida via Socket.IO.`);
      }
  });
  // NOVO: Listener para retornar ao stream principal (Voz do Coração Imaculado)
  socket.on('return-to-imaculado', () => {
      log(`Recebido comando para retornar ao stream principal (Voz do Coração Imaculado) via Socket.IO.`);
      changeStream(STREAMS.imaculado);
  });
  // NOVO: Listener para tocar uma mensagem aleatória do Google Drive
  socket.on('play-random-message', () => {
      if (messages.length > 0) {
          const randomIndex = Math.floor(Math.random() * messages.length);
          const message = messages[randomIndex];
          log(`Recebido comando para tocar mensagem aleatória: ${message.name} via Socket.IO.`);
          // A URL agora é o endpoint interno do servidor
          playMessage(`/message-stream/${message.id}`, message.name);
          // >>>>> REMOVIDO: setTimeout fixo aqui <<<<<
      } else {
          log("Recebido comando para tocar mensagem aleatória, mas nenhuma mensagem disponível.");
          // Opcional: emitir um evento para o cliente informar que não há mensagens
      }
  });
  // NOVO: Listener para quando a mensagem terminar no cliente
  socket.on('message-ended', () => {
      log('Recebido evento message-ended do cliente. Finalizando mensagem e retomando stream anterior.');
      stopMessageAndResumePrevious();
  });
  // Listener para forçar reconexão do player
  socket.on("force-reconnect", () => {
      log("Recebido comando para forçar reconexão do player via Socket.IO.");
      // Não precisamos mudar o currentStream, apenas forçar o cliente a reconectar
      killActiveStreams(); // Derruba as conexões existentes
      io.emit("play-stream", {
          url: "/stream",
          description: currentStream.description
      });
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
