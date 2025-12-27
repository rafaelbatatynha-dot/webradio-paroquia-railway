// server.js

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

// =================== CONFIGURAÇÃO GERAL ===================

const PORT = process.env.PORT || 10000;
const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';

// ID fixo da missa agendada no YouTube
const YOUTUBE_MISSA_VIDEO_ID = 'ZlXnuZcaJ2Y';

// URLs das rádios
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
    description: 'Missa de Sábado (YouTube)'
  }
};

// =================== ESTADO DA RÁDIO ===================

let currentStream = STREAMS.imaculado;
let messages = [];            // mensagens do Google Drive
let isPlayingMessage = false; // se está tocando mensagem agora

// =================== GOOGLE DRIVE ===================

async function authenticateGoogleDrive() {
  try {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
      throw new Error('Variável de ambiente GOOGLE_APPLICATION_CREDENTIALS_JSON não encontrada.');
    }

    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });

    console.log('✅ Credenciais do Google Drive carregadas.');
    return auth;
  } catch (err) {
    console.error('❌ Erro ao autenticar Google Drive:', err.message);
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

    console.log(`✅ ${messages.length} mensagens carregadas do Google Drive.`);
  } catch (err) {
    console.error('❌ Erro ao carregar mensagens do Drive:', err.message);
    messages = [];
  }
}

async function initializeGoogleDrive() {
  const auth = await authenticateGoogleDrive();
  await loadMessagesFromGoogleDrive(auth);
  return auth;
}

// =================== TOCAR MENSAGENS ===================

// Toca TODAS as mensagens em sequência (11h–12h)
async function playSequentialMessages() {
  if (messages.length === 0) {
    console.log('⚠️ Nenhuma mensagem para tocar.');
    return;
  }

  isPlayingMessage = true;
  console.log(`📢 Iniciando bloco sequencial de ${messages.length} mensagens.`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`📢 Mensagem ${i + 1}/${messages.length}: ${msg.name}`);

    io.emit('play-mensagem', {
      name: msg.name,
      url: msg.url
    });

    // aguarda 60s para cada mensagem
    await new Promise(res => setTimeout(res, 60_000));
  }

  console.log('⏹️ Fim do bloco de mensagens (11h–12h).');
  isPlayingMessage = false;
  io.emit('stop-mensagem');

  // volta para o stream atual
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

// Toca UMA mensagem aleatória (para noite)
async function playRandomMessage() {
  if (messages.length === 0) return;

  const msg = messages[Math.floor(Math.random() * messages.length)];
  console.log(`📢 Mensagem aleatória: ${msg.name}`);

  isPlayingMessage = true;
  io.emit('play-mensagem', {
    name: msg.name,
    url: msg.url
  });

  await new Promise(res => setTimeout(res, 60_000));

  isPlayingMessage = false;
  io.emit('stop-mensagem');
  io.emit('play-stream', { url: '/stream', description: currentStream.description });
}

// =================== AGENDAMENTO (HORÁRIO DO BRASIL) ===================
//
// ATENÇÃO: uso timeZone: 'America/Sao_Paulo' em TODOS os cron.schedule
// Assim ele obedece diretamente 00:10, 05:00, 11:00 no relógio de Brasília.
//

function setupSchedule() {
  console.log('⏰ Configurando agendamentos com fuso America/Sao_Paulo...');

  // 00:10 – muda para clássica
  cron.schedule(
    '10 0 * * *',
    () => {
      console.log('🎼 00:10 (BR) – Mudando para música clássica.');
      currentStream = STREAMS.classica;
      io.emit('play-stream', { url: '/stream', description: currentStream.description });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 00:15, 00:30, 00:45 ... 02:45 – mensagens a cada 15 min durante a clássica
  // (00–02 horas inteiras)
  cron.schedule(
    '0,15,30,45 0-2 * * *',
    () => {
      console.log('📢 Mensagem noturna (cada 15 min, 00h–02h45).');
      if (!isPlayingMessage) playRandomMessage();
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 03:00–05:00 você falou que às vezes quer ir até 03:00; aqui dá pra ajustar.
  // Vou deixar SEM mensagens extras depois de 03:00 para não poluir.

  // 05:00 – volta para Voz do Imaculado
  cron.schedule(
    '0 5 * * *',
    () => {
      console.log('📻 05:00 (BR) – Voltando para Voz do Coração Imaculado.');
      currentStream = STREAMS.imaculado;
      io.emit('play-stream', { url: '/stream', description: currentStream.description });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 11:00 – bloco diário de mensagens (todas, em sequência)
  cron.schedule(
    '0 11 * * *',
    () => {
      console.log('📢 11:00 (BR) – Iniciando bloco diário de mensagens (Drive).');
      playSequentialMessages();
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 12:00 – volta para Imaculado
  cron.schedule(
    '0 12 * * *',
    () => {
      console.log('📻 12:00 (BR) – Fim do bloco diário, voltando para Imaculado.');
      isPlayingMessage = false;
      currentStream = STREAMS.imaculado;
      io.emit('stop-mensagem');
      io.emit('play-stream', { url: '/stream', description: currentStream.description });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // Sábado 19:00 – Missa (YouTube)
  cron.schedule(
    '0 19 * * 6',
    () => {
      console.log('⛪ Sábado 19:00 (BR) – Entrando na Missa (YouTube).');
      currentStream = STREAMS.missa;
      io.emit('play-stream', { url: '/stream', description: currentStream.description });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // Sábado 20:30 – volta para Imaculado
  cron.schedule(
    '30 20 * * 6',
    () => {
      console.log('📻 Sábado 20:30 (BR) – Fim da Missa, voltando para Imaculado.');
      currentStream = STREAMS.imaculado;
      io.emit('play-stream', { url: '/stream', description: currentStream.description });
    },
    { timezone: 'America/Sao_Paulo' }
  );

  console.log('✅ Agendamentos configurados (timezone America/Sao_Paulo).');
}

// =================== /stream – PROXY + YOUTUBE ===================

app.get('/stream', async (req, res) => {
  try {
    const streamUrl = currentStream.url;

    // ---- Se for YouTube (missa) ----
    if (streamUrl.includes('youtube.com') || streamUrl.includes('youtu.be')) {
      console.log('🎥 Enviando áudio do YouTube:', streamUrl);

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

        // tenta usar ffmpeg para padronizar o áudio
        exec('which ffmpeg', (error) => {
          if (error) {
            console.warn('⚠️ FFmpeg não encontrado, enviando áudio direto do YouTube.');
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
            '-content_type', 'audio/mpeg',
            'pipe:1'
          ]);

          audioStream.pipe(ffmpeg.stdin);
          ffmpeg.stdout.pipe(res);

          ffmpeg.on('error', (err) => {
            console.error('❌ Erro no ffmpeg (YouTube):', err.message);
            if (!res.headersSent) res.status(500).send('Erro no áudio da Missa');
          });

          audioStream.on('error', (err) => {
            console.error('❌ Erro no ytdl-core:', err.message);
            ffmpeg.kill();
            if (!res.headersSent) res.status(500).send('Erro no stream do YouTube');
          });

          res.on('close', () => {
            console.log('🔌 Cliente desconectou do stream YouTube.');
            ffmpeg.kill();
          });
        });

        return;
      } catch (ytErr) {
        console.error('❌ Erro ao processar YouTube:', ytErr.message);

        // Se não conseguir tocar a Missa → volta para Imaculado
        console.log('⚠️ Falha na Missa, voltando para programação normal.');
        currentStream = STREAMS.imaculado;
        io.emit('play-stream', { url: '/stream', description: currentStream.description });

        if (!res.headersSent) {
          res.status(500).send('Missa indisponível, rádio normal retomada.');
        }
        return;
      }
    }

    // ---- Proxy normal para rádios (Imaculado, Marabá, Clássica) ----
    console.log('🔗 Proxying stream:', streamUrl);

    const target = new URL(streamUrl);
    const client = target.protocol === 'https:' ? https : http;

    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Icy-MetaData': '0'
      },
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
      console.error('❌ Erro ao conectar no stream:', err.message);
      if (!res.headersSent) res.status(500).send('Stream indisponível.');
    });

    reqStream.on('timeout', () => {
      console.error('⏱️ Timeout no stream.');
      reqStream.destroy();
      if (!res.headersSent) res.status(504).send('Timeout no stream.');
    });

    reqStream.end();
  } catch (err) {
    console.error('❌ Erro na rota /stream:', err.message);
    if (!res.headersSent) res.status(500).send('Erro ao carregar stream.');
  }
});

// =================== ROTAS AUXILIARES ===================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    currentStream: currentStream.description,
    youtubeVideoId: YOUTUBE_MISSA_VIDEO_ID,
    messages: messages.length,
    now: new Date().toISOString()
  });
});

app.get('/api/messages', (req, res) => {
  res.json({ total: messages.length, messages });
});

// =================== SOCKET.IO ===================

io.on('connection', (socket) => {
  console.log('✅ Cliente conectado:', socket.id);
  socket.emit('play-stream', { url: '/stream', description: currentStream.description });

  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
  });

  socket.on('get-current-stream', () => {
    socket.emit('play-stream', { url: '/stream', description: currentStream.description });
  });
});

// =================== INÍCIO DO SERVIDOR ===================

async function startServer() {
  try {
    await initializeGoogleDrive();
    setupSchedule();

    server.listen(PORT, () => {
      console.log('\n╔═════════════════════════════════════════════════════╗');
      console.log('║  📡 Servidor iniciado com sucesso                   ║');
      console.log(`║  🌐 Porta: ${PORT.toString().padEnd(43, ' ')}║`);
      console.log(`║  📂 Pasta Google Drive: ${GOOGLE_DRIVE_FOLDER_ID.padEnd(28, ' ')}║`);
      console.log(`║  📊 Mensagens: ${String(messages.length).padEnd(42, ' ')}║`);
      console.log(`║  📻 Stream inicial: ${currentStream.description.padEnd(34, ' ')}║`);
      console.log('║  🎼 Clássica: 00h10–05h00 (BR)                      ║');
      console.log('║  📢 Mensagens: a cada 15 min (00h–02h45 BR)         ║');
      console.log('║  🕚 Bloco diário: 11h–12h (BR)                      ║');
      console.log('║  ⛪ Missa: sábado 19h–20h30 (BR, YouTube)           ║');
      console.log(`║  🎥 YouTube ID: ${YOUTUBE_MISSA_VIDEO_ID.padEnd(39, ' ')}║`);
      console.log('╚═════════════════════════════════════════════════════╝\n');
    });
  } catch (err) {
    console.error('❌ Erro ao iniciar servidor:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  console.log('⚠️ Encerrando servidor (SIGTERM)...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('⚠️ Encerrando servidor (SIGINT)...');
  process.exit(0);
});

startServer();
