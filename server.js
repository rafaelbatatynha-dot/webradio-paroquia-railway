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

const PORT = process.env.PORT || 10000;
const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';
const YOUTUBE_MISSA_VIDEO_ID = 'ZlXnuZcaJ2Y';

const STREAMS = {
  maraba: {
    url: 'https://streaming.speedrs.com.br/radio/8010/maraba',
    description: 'Marabá'
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
    description: 'Missa de Sábado'
  }
};

let currentStream = STREAMS.imaculado;
let messages = [];
let isPlayingMessage = false;

async function authenticateGoogleDrive() {
  try {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON não encontrada');
    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    console.log('✅ Google Drive autenticado');
    return auth;
  } catch (err) {
    console.error('❌ Erro Google Drive:', err.message);
    throw err;
  }
}

async function loadMessagesFromGoogleDrive(auth) {
  try {
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
    console.log(`✅ ${messages.length} mensagens carregadas`);
  } catch (err) {
    console.error('❌ Erro ao carregar mensagens:', err.message);
    messages = [];
  }
}

async function initializeGoogleDrive() {
  const auth = await authenticateGoogleDrive();
  await loadMessagesFromGoogleDrive(auth);
}

async function playSequentialMessages() {
  if (messages.length === 0) {
    console.log('⚠️ Sem mensagens');
    return;
  }
  isPlayingMessage = true;
  console.log(`📢 [${new Date().toLocaleString('pt-BR')}] Bloco de ${messages.length} mensagens`);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`📢 ${i + 1}/${messages.length}: ${msg.name}`);
    io.emit('play-mensagem', { name: msg.name, url: msg.url });
    await new Promise(res => setTimeout(res, 60000));
  }
  console.log(`⏹️ [${new Date().toLocaleString('pt-BR')}] Fim do bloco`);
  isPlayingMessage = false;
  io.emit('stop-mensagem');
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

async function playRandomMessage() {
  if (messages.length === 0) return;
  const msg = messages[Math.floor(Math.random() * messages.length)];
  console.log(`📢 [${new Date().toLocaleString('pt-BR')}] Mensagem: ${msg.name}`);
  isPlayingMessage = true;
  io.emit('play-mensagem', { name: msg.name, url: msg.url });
  await new Promise(res => setTimeout(res, 60000));
  isPlayingMessage = false;
  io.emit('stop-mensagem');
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

function setupSchedule() {
  console.log('⏰ Configurando agendamentos...');
  console.log(`🕐 Timezone: ${process.env.TZ || 'padrão do sistema'}`);
  console.log(`🕐 Hora atual: ${new Date().toLocaleString('pt-BR')}`);

  cron.schedule('10 0 * * *', () => {
    console.log(`🎼 [${new Date().toLocaleString('pt-BR')}] 00:10 - Clássica`);
    currentStream = STREAMS.classica;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  cron.schedule('15,30,45 0 * * *', () => {
    console.log(`📢 [${new Date().toLocaleString('pt-BR')}] Mensagem noturna`);
    if (!isPlayingMessage) playRandomMessage();
  });

  cron.schedule('0,15,30,45 1-2 * * *', () => {
    console.log(`📢 [${new Date().toLocaleString('pt-BR')}] Mensagem noturna`);
    if (!isPlayingMessage) playRandomMessage();
  });

  cron.schedule('0 3 * * *', () => {
    console.log(`📻 [${new Date().toLocaleString('pt-BR')}] 03:00 - Imaculado`);
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  cron.schedule('0 11 * * *', () => {
    console.log(`📢 [${new Date().toLocaleString('pt-BR')}] 11:00 - Bloco diário`);
    playSequentialMessages();
  });

  cron.schedule('0 12 * * *', () => {
    console.log(`📻 [${new Date().toLocaleString('pt-BR')}] 12:00 - Imaculado`);
    isPlayingMessage = false;
    currentStream = STREAMS.imaculado;
    io.emit('stop-mensagem');
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  cron.schedule('0 19 * * 6', () => {
    console.log(`⛪ [${new Date().toLocaleString('pt-BR')}] Sábado 19:00 - Missa`);
    currentStream = STREAMS.missa;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  cron.schedule('30 20 * * 6', () => {
    console.log(`📻 [${new Date().toLocaleString('pt-BR')}] Sábado 20:30 - Imaculado`);
    currentStream = STREAMS.imaculado;
    io.emit('play-stream', { url: '/stream', description: currentStream.description });
  });

  console.log('✅ Agendamentos configurados');
}

app.get('/stream', async (req, res) => {
  try {
    const streamUrl = currentStream.url;

    if (streamUrl.includes('youtube.com') || streamUrl.includes('youtu.be')) {
      console.log('🎥 YouTube:', streamUrl);
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
            console.warn('⚠️ FFmpeg não encontrado');
            audioStream.pipe(res);
            return;
          }

          const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0', '-f', 'mp3', '-codec:a', 'libmp3lame',
            '-b:a', '128k', '-ar', '44100', '-ac', '2', 'pipe:1'
          ]);

          audioStream.pipe(ffmpeg.stdin);
          ffmpeg.stdout.pipe(res);

          ffmpeg.on('error', (err) => {
            console.error('❌ FFmpeg:', err.message);
            if (!res.headersSent) res.status(500).send('Erro FFmpeg');
          });

          audioStream.on('error', (err) => {
            console.error('❌ ytdl:', err.message);
            ffmpeg.kill();
            if (!res.headersSent) res.status(500).send('Erro YouTube');
          });

          res.on('close', () => {
            console.log('🔌 Cliente desconectou');
            ffmpeg.kill();
          });
        });
        return;
      } catch (ytErr) {
        console.error('❌ YouTube:', ytErr.message);
        console.log('⚠️ Voltando para Imaculado');
        currentStream = STREAMS.imaculado;
        io.emit('play-stream', { url: '/stream', description: currentStream.description });
        if (!res.headersSent) res.status(500).send('Missa indisponível');
        return;
      }
    }

    console.log('🔗 Proxy:', streamUrl);
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
      console.error('❌ Stream:', err.message);
      if (!res.headersSent) res.status(500).send('Stream indisponível');
    });

    reqStream.on('timeout', () => {
      console.error('⏱️ Timeout');
      reqStream.destroy();
      if (!res.headersSent) res.status(504).send('Timeout');
    });

    reqStream.end();
  } catch (err) {
    console.error('❌ /stream:', err.message);
    if (!res.headersSent) res.status(500).send('Erro');
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    currentStream: currentStream.description,
    youtubeVideoId: YOUTUBE_MISSA_VIDEO_ID,
    messages: messages.length,
    timezone: process.env.TZ || 'não definido',
    serverTime: new Date().toString(),
    serverTimeBR: new Date().toLocaleString('pt-BR')
  });
});

app.get('/api/messages', (req, res) => {
  res.json({ total: messages.length, messages });
});

io.on('connection', (socket) => {
  console.log('✅ Cliente:', socket.id);
  socket.emit('play-stream', { url: '/stream', description: currentStream.description });
  socket.on('disconnect', () => console.log('❌ Cliente:', socket.id));
  socket.on('get-current-stream', () => {
    socket.emit('play-stream', { url: '/stream', description: currentStream.description });
  });
});

async function startServer() {
  try {
    await initializeGoogleDrive();
    setupSchedule();

    server.listen(PORT, () => {
      console.log('\n╔═══════════════════════════════════════════╗');
      console.log('║  📡 Servidor iniciado                     ║');
      console.log(`║  🌐 Porta: ${PORT}                           ║`);
      console.log(`║  🕐 TZ: ${(process.env.TZ || 'padrão').padEnd(32, ' ')}║`);
      console.log(`║  🕐 Hora: ${new Date().toLocaleString('pt-BR').padEnd(30, ' ')}║`);
      console.log(`║  📊 Mensagens: ${messages.length}                       ║`);
      console.log(`║  📻 Stream: ${currentStream.description.padEnd(28, ' ')}║`);
      console.log('║  🎼 Clássica: 00h10–03h00                 ║');
      console.log('║  📢 Mensagens: cada 15 min (00h–02h45)    ║');
      console.log('║  🕚 Bloco: 11h–12h                        ║');
      console.log('║  ⛪ Missa: sáb 19h–20h30                  ║');
      console.log('╚═══════════════════════════════════════════╝\n');
    });
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { console.log('⚠️ Encerrando...'); process.exit(0); });
process.on('SIGINT', () => { console.log('⚠️ Encerrando...'); process.exit(0); });

startServer();
