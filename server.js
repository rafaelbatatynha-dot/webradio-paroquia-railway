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
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

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
  missa: {
    url: `https://www.youtube.com/watch?v=${YOUTUBE_MISSA_VIDEO_ID}`,
    description: 'Missa de Sábado (YouTube)'
  }
};

let currentStream = STREAMS.imaculado;
let messages = [];
let isPlayingMessage = false;

// =================== Funções de horário/log ===================

function getBrazilTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const brazilTime = new Date(utc + (3600000 * -3)); // UTC-3
  return brazilTime;
}

function logBrazilTime(message) {
  const br = getBrazilTime();
  const timeStr = br.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  console.log(`[${timeStr} BR] ${message}`);
}

// =================== Google Drive ===================

async function authenticateGoogleDrive() {
  try {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON não encontrada');
    }

    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });

    logBrazilTime('✅ Google Drive autenticado');
    return auth;
  } catch (err) {
    logBrazilTime(`❌ Erro Google Drive: ${err.message}`);
    return null; // NÃO derruba o servidor
  }
}

async function loadMessagesFromGoogleDrive(auth) {
  try {
    if (!auth) {
      logBrazilTime('⚠️ Sem auth do Google Drive, não carregando mensagens');
      messages = [];
      return;
    }

    const drive = google.drive({ version: 'v3', auth });
    const resp = await drive.files.list({
      q: `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and mimeType contains 'audio'`,
      spaces: 'drive',
      fields: 'files(id, name, mimeType)',
      pageSize: 1000
    });

    const files = resp.data.files || [];
    messages = files.map(f => ({
      id: f.id,
      name: f.name,
      url: `https://drive.google.com/uc?id=${f.id}&export=download`
    }));

    logBrazilTime(`✅ ${messages.length} mensagens carregadas`);
  } catch (err) {
    logBrazilTime(`❌ Erro ao carregar mensagens: ${err.message}`);
    messages = [];
  }
}

async function initializeGoogleDrive() {
  const auth = await authenticateGoogleDrive();
  if (!auth) return;
  await loadMessagesFromGoogleDrive(auth);
}

// =================== Reprodução de mensagens ===================

async function playSequentialMessages() {
  if (messages.length === 0) {
    logBrazilTime('⚠️ Sem mensagens para bloco sequencial');
    return;
  }

  isPlayingMessage = true;
  logBrazilTime(`📢 Iniciando bloco de ${messages.length} mensagens`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    logBrazilTime(`📢 ${i + 1}/${messages.length}: ${msg.name}`);
    io.emit('play-mensagem', { name: msg.name, url: msg.url });
    await new Promise(res => setTimeout(res, 60000)); // 60s por mensagem
  }

  logBrazilTime('⏹️ Fim do bloco de mensagens');
  isPlayingMessage = false;
  io.emit('stop-mensagem');
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

async function playRandomMessage() {
  if (messages.length === 0) {
    logBrazilTime('⚠️ Sem mensagens para sorteio');
    return;
  }

  const msg = messages[Math.floor(Math.random() * messages.length)];
  logBrazilTime(`📢 Mensagem aleatória: ${msg.name}`);

  isPlayingMessage = true;
  io.emit('play-mensagem', { name: msg.name, url: msg.url });

  await new Promise(res => setTimeout(res, 60000));

  isPlayingMessage = false;
  io.emit('stop-mensagem');
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

// =================== Agendamentos (programação da rádio) ===================

function setupSchedule() {
  logBrazilTime('⏰ Configurando agendamentos (UTC → Brasil)...');

  // 00:10 BR - Música Clássica (equivalente UTC 03:10)
  cron.schedule('10 3 * * *', () => {
    logBrazilTime('🎼 00:10 BR - Música Clássica');
    currentStream = STREAMS.classica;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // 00h BR - mensagens 00:15, 00:30, 00:45 (UTC 03h)
  cron.schedule('15,30,45 3 * * *', () => {
    logBrazilTime('📢 Mensagem noturna (00h BR)');
    if (!isPlayingMessage) playRandomMessage();
  });

  // 01h–04h BR - mensagens a cada 15min (UTC 04–07)
  cron.schedule('0,15,30,45 4-7 * * *', () => {
    logBrazilTime('📢 Mensagem noturna (01h–04h BR)');
    if (!isPlayingMessage) playRandomMessage();
  });

  // 05:00 BR - volta Voz do Imaculado (UTC 08:00)
  cron.schedule('0 8 * * *', () => {
    logBrazilTime('📻 05:00 BR - Voz do Imaculado');
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // 11:00 BR - bloco diário de todas as mensagens (UTC 14:00)
  cron.schedule('0 14 * * *', () => {
    logBrazilTime('📢 11:00 BR - Bloco de mensagens diário');
    playSequentialMessages();
  });

  // 12:00 BR - volta Imaculado (UTC 15:00)
  cron.schedule('0 15 * * *', () => {
    logBrazilTime('📻 12:00 BR - Volta Imaculado');
    isPlayingMessage = false;
    currentStream = STREAMS.imaculado;
    io.emit('stop-mensagem');
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Sábado 12:50 BR - Informativo Paroquial (Marabá) (UTC 15:50)
  cron.schedule('50 15 * * 6', () => {
    logBrazilTime('📰 Sábado 12:50 BR - Informativo Paroquial (Rádio Marabá)');
    currentStream = STREAMS.maraba;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Sábado 13:05 BR - volta Imaculado (UTC 16:05)
  cron.schedule('5 16 * * 6', () => {
    logBrazilTime('📻 Sábado 13:05 BR - Volta Imaculado');
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Sábado 19:00 BR - Missa YouTube (UTC 22:00)
  cron.schedule('0 22 * * 6', () => {
    logBrazilTime('⛪ Sábado 19:00 BR - Missa (YouTube)');
    currentStream = STREAMS.missa;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Sábado 20:30 BR - volta Imaculado (UTC 23:30)
  cron.schedule('30 23 * * 6', () => {
    logBrazilTime('📻 Sábado 20:30 BR - Volta Imaculado');
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Domingo 08:30 BR - Missa Marabá (UTC 11:30)
  cron.schedule('30 11 * * 0', () => {
    logBrazilTime('⛪ Domingo 08:30 BR - Missa (Rádio Marabá)');
    currentStream = STREAMS.maraba;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  // Domingo 09:30 BR - volta Imaculado (UTC 12:30)
  cron.schedule('30 12 * * 0', () => {
    logBrazilTime('📻 Domingo 09:30 BR - Volta Imaculado');
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  logBrazilTime('✅ Agendamentos configurados (UTC → Brasil)');
}

// =================== Rota /stream ===================

app.get('/stream', async (req, res) => {
  try {
    const streamUrl = currentStream.url;

    if (streamUrl.includes('youtube.com') || streamUrl.includes('youtu.be')) {
      logBrazilTime(`🎥 YouTube: ${streamUrl}`);

      try {
        const audioStream = ytdl(streamUrl, {
          filter: 'audioonly',
          quality: 'highestaudio',
          highWaterMark: 1 << 25
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Transfer-Encoding', 'chunked');

        exec('which ffmpeg', (error) => {
          if (error) {
            logBrazilTime('⚠️ FFmpeg não encontrado, enviando áudio original');
            audioStream.pipe(res);
            return;
          }

          const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-f', 'mp3',
            '-codec:a', 'libmp3lame',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            'pipe:1'
          ]);

          audioStream.pipe(ffmpeg.stdin);
          ffmpeg.stdout.pipe(res);

          ffmpeg.on('error', (err) => {
            logBrazilTime(`❌ FFmpeg: ${err.message}`);
            if (!res.headersSent) res.status(500).send('Erro FFmpeg');
          });

          audioStream.on('error', (err) => {
            logBrazilTime(`❌ ytdl: ${err.message}`);
            ffmpeg.kill();
            if (!res.headersSent) res.status(500).send('Erro YouTube');
          });

          res.on('close', () => {
            logBrazilTime('🔌 Cliente desconectou');
            ffmpeg.kill();
          });
        });

        return;
      } catch (ytErr) {
        logBrazilTime(`❌ YouTube: ${ytErr.message}`);
        logBrazilTime('⚠️ Voltando para Imaculado');
        currentStream = STREAMS.imaculado;
        io.emit('play-stream', { url: '/stream', description: currentStream.description });
        if (!res.headersSent) res.status(500).send('Missa indisponível');
        return;
      }
    }

    logBrazilTime(`🔗 Proxy: ${streamUrl}`);
    const target = new URL(streamUrl);
    const client = target.protocol === 'https:' ? https : http;

    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Icy-MetaData': '0' },
      timeout: 8000
    };

    const reqStream = client.request(options, (streamRes) => {
      res.writeHead(streamRes.statusCode, {
        'Content-Type': streamRes.headers['content-type'] || 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked'
      });
      streamRes.pipe(res);
    });

    reqStream.on('error', (err) => {
      logBrazilTime(`❌ Stream: ${err.message}`);
      if (!res.headersSent) res.status(500).send('Stream indisponível');
    });

    reqStream.on('timeout', () => {
      logBrazilTime('⏱️ Timeout');
      reqStream.destroy();
      if (!res.headersSent) res.status(504).send('Timeout');
    });

    reqStream.end();
  } catch (err) {
    logBrazilTime(`❌ /stream: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Erro');
  }
});

// =================== Rotas HTTP simples ===================

// Healthcheck para o Railway
app.get('/health', (req, res) => {
  const br = getBrazilTime();
  res.json({
    status: 'ok',
    currentStream: currentStream.description,
    youtubeVideoId: YOUTUBE_MISSA_VIDEO_ID,
    messages: messages.length,
    serverTimeBR: br.toLocaleString('pt-BR'),
    serverTimeUTC: new Date().toISOString()
  });
});

// Raiz
app.get('/', (req, res) => {
  res.send('Web Rádio Paróquia - OK');
});

// API de mensagens
app.get('/api/messages', (req, res) => {
  res.json({ total: messages.length, messages });
});

// =================== Socket.IO ===================

io.on('connection', (socket) => {
  logBrazilTime(`✅ Cliente conectado: ${socket.id}`);
  socket.emit('play-stream', { url: '/stream', description: currentStream.description });

  socket.on('disconnect', () => logBrazilTime(`❌ Cliente desconectado: ${socket.id}`));

  socket.on('get-current-stream', () => {
    socket.emit('play-stream', { url: '/stream', description: currentStream.description });
  });
});

// =================== Inicialização (ajustada para Railway) ===================

async function startServer() {
  // 1. Sobe o servidor imediatamente, para o Railway conseguir bater em /health
  server.listen(PORT, '0.0.0.0', () => {
    const br = getBrazilTime();
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║  📡 Servidor iniciado                     ║');
    console.log(`║  🌐 Porta: ${PORT.toString().padEnd(30, ' ')}║`);
    console.log(`║  🕐 Hora BR: ${br.toLocaleString('pt-BR').padEnd(28, ' ')}║`);
    console.log(`║  📻 Stream inicial: ${currentStream.description.padEnd(19, ' ')}║`);
    console.log('╚═══════════════════════════════════════════╝\n');
  });

  // 2. Depois, em background, carrega Drive e agenda
  setTimeout(async () => {
    try {
      await initializeGoogleDrive();
      setupSchedule();
      logBrazilTime('⚙️ Inicialização completa (Drive + agendamentos)');
    } catch (err) {
      logBrazilTime(`❌ Erro na inicialização em background: ${err.message}`);
    }
  }, 1500);
}

process.on('SIGTERM', () => { logBrazilTime('⚠️ Encerrando...'); process.exit(0); });
process.on('SIGINT', () => { logBrazilTime('⚠️ Encerrando...'); process.exit(0); });

startServer();
