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
let blockRunning = false; // Bloqueia a execução de múltiplos blocos de programação
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
      fields: "files(id,name,webContentLink)", // NOVO: Pedir webContentLink
      pageSize: 500,
    });
    const files = resp.data.files || [];
    messages = files.map((f) => ({
      id: f.id,
      name: f.name,
      // NOVO: Usar a API de exportação de mídia diretamente
      url: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
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
  log(`Tocando mensagem: ${messageName}`);
}
function stopMessageAndResumePrevious() {
  isPlayingMessage = false;
  io.emit("stop-message"); // Informa clientes que a mensagem parou
  currentStream = previousStream; // Volta para o stream que estava tocando antes da mensagem
  resumeStream(); // Retoma o stream principal
  log(`Mensagem finalizada. Retomando stream: ${currentStream.description}`);
}
// Função para mudar o stream principal (usada por agendamentos e override manual)
function changeStream(newStream) {
    if (currentStream.url === newStream.url) {
        log(`Stream já é ${newStream.description}. Nenhuma mudança necessária.`);
        return;
    }
    currentStream = newStream;
    resumeStream(); // Força a troca para o novo stream
}
// ---------------------- CRON JOBS (AGENDAMENTOS) ----------------------
// Função para obter a data e hora atual no fuso horário do servidor
function getServerTimeInTZ() {
    return new Date().toLocaleString("en-US", { timeZone: TZ });
}
// CRON TESTE: Dispara a cada minuto para verificar se o cron está ativo
cron.schedule('* * * * *', () => {
    const serverTime = new Date();
    log(`CRON TESTE: Disparado a cada minuto. UTC: ${serverTime.toISOString()} | BR: ${serverTime.toLocaleString('pt-BR', { timeZone: TZ })}`);
}, {
    scheduled: true,
    timezone: TZ // Garante que o cron use o fuso horário correto para agendamento
});
// Exemplo de agendamento: Rádio Marabá às 00:10 BR (03:10 UTC)
cron.schedule('10 0 * * *', () => { // 10 minutos depois da meia-noite (00:10)
    log(`CRON: 00:10 BR – Iniciando Rádio Marabá`);
    changeStream(STREAMS.maraba);
}, {
    scheduled: true,
    timezone: TZ
});
// Exemplo de agendamento: Música Clássica às 01:00 BR (04:00 UTC)
cron.schedule('0 1 * * *', () => { // 1 hora da manhã (01:00)
    log(`CRON: 01:00 BR – Iniciando Música Clássica`);
    changeStream(STREAMS.classica);
}, {
    scheduled: true,
    timezone: TZ
});
// Exemplo de agendamento: Missa de Sábado (YouTube) às 19:00 BR (22:00 UTC)
cron.schedule('0 19 * * 6', () => { // Sábado às 19:00
    log(`CRON: Sábado 19:00 BR – Iniciando Missa de Sábado (YouTube)`);
    changeStream(STREAMS.missaYoutube);
}, {
    scheduled: true,
    timezone: TZ
});
// Exemplo de agendamento: Retorno à Voz do Coração Imaculado às 02:00 BR (05:00 UTC)
cron.schedule('0 2 * * *', () => { // 2 horas da manhã (02:00)
    log(`CRON: 02:00 BR – Retornando à Voz do Coração Imaculado`);
    changeStream(STREAMS.imaculado);
}, {
    scheduled: true,
    timezone: TZ
});
// Exemplo de agendamento: Retorno à Voz do Coração Imaculado às 20:00 BR (23:00 UTC) no sábado
cron.schedule('0 20 * * 6', () => { // Sábado às 20:00
    log(`CRON: Sábado 20:00 BR – Retornando à Voz do Coração Imaculado`);
    changeStream(STREAMS.imaculado);
}, {
    scheduled: true,
    timezone: TZ
});
// Agendamento para tocar uma mensagem aleatória a cada 15 minutos (exemplo)
cron.schedule('*/15 * * * *', () => {
    if (messages.length > 0 && !isPlayingMessage) {
        const randomIndex = Math.floor(Math.random() * messages.length);
        const message = messages[randomIndex];
        log(`CRON: Tocando mensagem agendada: ${message.name}`);
        playMessage(message.url, message.name);
        // Agendar para voltar ao stream anterior após um tempo (ex: 30 segundos)
        setTimeout(stopMessageAndResumePrevious, 30 * 1000); // Ajuste conforme a duração média das mensagens
    } else if (messages.length === 0) {
        log("CRON: Nenhuma mensagem disponível para tocar.");
    } else {
        log("CRON: Mensagem já está tocando, pulando agendamento.");
    }
}, {
    scheduled: true,
    timezone: TZ
});
log(`Agendamentos carregados (timezone fixo BR).`);
// ---------------------- ENDPOINTS ----------------------
app.get("/stream", (req, res) => {
  const url = currentStream.url;
  activeStreamResponses.add(res);
  req.on("close", () => {
    activeStreamResponses.delete(res);
  });
  try {
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      // Lógica para YouTube (Missa)
      const videoId = ytdl.getURLVideoID(url);
      const audioStream = ytdl(videoId, {
        quality: "lowestaudio",
        filter: "audioonly",
      });
      const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      audioStream.pipe(passthrough).pipe(res);
      audioStream.on("error", (e) => {
        log("Erro YouTube stream: " + e.message);
        passthrough.destroy(e);
      });
      passthrough.on("error", (e) => {
          log("Erro passthrough (YouTube): " + e.message);
          try { res.end(); } catch (err) {}
      });
    } else if (url.includes("googleapis.com/drive/v3/files")) { // NOVO: Detecta a nova URL da API do Google Drive
      // Lógica para Google Drive (mensagens)
      const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1MB buffer
      const target = new URL(url);
      const client = target.protocol === "https:" ? https : http;
      let currentUrl = url;
      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) { // Limite de redirecionamentos
          log("Erro Google Drive: Limite de redirecionamentos excedido.");
          try {
            res.status(500).end("Erro ao carregar stream do Google Drive: Limite de redirecionamentos excedido.");
          } catch (err) {}
          return;
        }
        const driveReq = client.request(
          {
            hostname: new URL(requestUrl).hostname,
            port: new URL(requestUrl).port || (new URL(requestUrl).protocol === "https:" ? 443 : 80),
            path: new URL(requestUrl).pathname + new URL(requestUrl).search,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Authorization": `Bearer ${authenticateDrive()._cachedAuth.credentials.access_token}`, // NOVO: Adiciona token de autorização
            },
          },
          (driveRes) => {
            if (driveRes.statusCode >= 300 && driveRes.statusCode < 400 && driveRes.headers.location) {
              // Lidar com redirecionamento
              log(`Google Drive redirecionando para: ${driveRes.headers.location}`);
              makeRequest(driveRes.headers.location, redirectCount + 1);
            } else if (driveRes.statusCode === 200) {
              // Stream OK
              const headersToSend = {
                  "Content-Type": "audio/mpeg", // Força Content-Type para áudio
                  "Accept-Ranges": "bytes", // Adiciona Accept-Ranges para permitir seek
              };
              // Copia outros headers relevantes, mas remove os problemáticos
              Object.keys(driveRes.headers).forEach(key => {
                  const lowerKey = key.toLowerCase();
                  if (lowerKey !== 'transfer-encoding' &&
                      lowerKey !== 'content-type' && // Não copia, pois estamos forçando o nosso
                      lowerKey !== 'content-disposition' && // Remove para evitar download
                      lowerKey !== 'cache-control' &&
                      lowerKey !== 'pragma' &&
                      lowerKey !== 'expires' &&
                      lowerKey !== 'set-cookie') { // Remove cookies se houver
                      headersToSend[key] = driveRes.headers[key];
                  }
              });
              res.writeHead(200, headersToSend);
              driveRes.pipe(passthrough).pipe(res);

              driveRes.on("error", (e) => {
                log("Erro driveRes (Google Drive upstream): " + e.message);
                passthrough.destroy(e);
              });
              passthrough.on("error", (e) => {
                  log("Erro passthrough (Google Drive): " + e.message);
                  try { res.end(); } catch (err) {}
              });
              driveRes.on("close", () => {
                  log("Stream Google Drive upstream fechado.");
              });
            } else {
              log(`Erro Google Drive: Status ${driveRes.statusCode}`);
              try {
                res.status(500).end(`Erro ao carregar stream do Google Drive: Status ${driveRes.statusCode}`);
              } catch (err) {}
            }
          }
        );
        driveReq.on("error", (e) => {
          log("Erro Google Drive stream (driveReq): " + e.message);
          try {
            res.status(500).end("Erro ao carregar stream do Google Drive.");
          } catch (err) {}
        });
        driveReq.end();
      };
      makeRequest(currentUrl); // Inicia a requisição
    } else {
      // Proxy normal (http/https)
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
          playMessage(message.url, message.name);
          // Agendar para voltar ao stream anterior após um tempo (ex: 30 segundos)
          setTimeout(stopMessageAndResumePrevious, 30 * 1000); // Ajuste conforme a duração média das mensagens
      } else {
          log("Recebido comando para tocar mensagem aleatória, mas nenhuma mensagem disponível.");
          // Opcional: emitir um evento para o cliente informar que não há mensagens
      }
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
