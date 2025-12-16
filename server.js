const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process'); // Para rodar comandos externos como ffmpeg
const app = express();

// ===== CONFIGURAÇÃO DO CORS =====
const allowedOrigins = [
    'https://www.paroquiaauxiliadorairai.com.br',
    'https://webradio-paroquia.onrender.com',
    'http://localhost:3000'
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'CORS policy violation';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;
const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';

// ===== SUAS URLs DOS STREAMS DE RÁDIO (NÃO ALTERADAS!) =====
// Rafael, estas são as URLs EXATAS que você me forneceu.
// Elas foram mantidas aqui sem nenhuma alteração.
const RADIO_VOZ_IMACULADO_URL = 'http://r13.ciclano.io:9033/live'; // Rádio Voz do Coração Imaculado
const RADIO_MARABA_URL = 'https://streaming.speedrs.com.br/radio/8010/maraba'; // Rádio Marabá
const RADIO_CLASSICA_URL = 'https://stream.srg-ssr.ch/m/rsc_de/mp3_128'; // Swiss Classic Radio
// ==============================================================================

app.use(express.static('public'));

// ===== VARIÁVEIS GLOBAIS =====
let currentPlayingStream = {
    url: '', // Esta URL será o endpoint LOCAL do seu servidor (ex: '/stream')
    description: ''
};
let isPlayingMessage = false;
let messageTimeout = null;
let ffmpegProcess = null; // Variável para armazenar o processo FFmpeg

// Função para iniciar o stream FFmpeg
function startFfmpegStream(sourceUrl, res) {
    // Se já houver um processo FFmpeg rodando, encerra-o primeiro
    if (ffmpegProcess) {
        console.log('🔄 Encerrando processo FFmpeg anterior...');
        ffmpegProcess.kill('SIGKILL'); // Força o encerramento
        ffmpegProcess = null;
    }

    console.log(`▶️ Iniciando FFmpeg para stream: ${sourceUrl}`);
    // O FFmpeg vai ler da sourceUrl e enviar o output para o pipe (stdout)
    // -i ${sourceUrl}: Define a URL de entrada
    // -c:a libmp3lame: Define o codec de áudio para MP3
    // -q:a 2: Define a qualidade do áudio (2 é uma boa qualidade para MP3)
    // -f mp3: Define o formato de saída como MP3
    // -ar 44100: Define a taxa de amostragem de áudio para 44.1 kHz
    // -ac 2: Define 2 canais de áudio (estéreo)
    // pipe:1: Envia a saída para o stdout (pipe)
    ffmpegProcess = spawn('ffmpeg', [
        '-i', sourceUrl,
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        '-f', 'mp3',
        '-ar', '44100',
        '-ac', '2',
        'pipe:1'
    ]);

    // Quando o FFmpeg tem dados, ele os envia para a resposta HTTP
    ffmpegProcess.stdout.pipe(res);

    // Lida com erros do FFmpeg
    ffmpegProcess.stderr.on('data', (data) => {
        console.error(`❌ FFmpeg stderr: ${data}`);
    });

    // Lida com o fechamento do processo FFmpeg
    ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`❌ FFmpeg process exited with code ${code}`);
        } else {
            console.log('⏹️ FFmpeg process closed gracefully.');
        }
        ffmpegProcess = null; // Limpa a referência
    });

    // Lida com erros de spawn (ex: ffmpeg não encontrado)
    ffmpegProcess.on('error', (err) => {
        console.error('❌ Failed to start FFmpeg process:', err);
        res.status(500).send('Erro ao iniciar o stream de rádio.');
        ffmpegProcess = null;
    });

    // Quando a conexão HTTP com o cliente é fechada, encerra o FFmpeg
    res.on('close', () => {
        if (ffmpegProcess) {
            console.log('🔌 Cliente desconectado, encerrando FFmpeg...');
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
        }
    });
}

// ===== ROTA PRINCIPAL PARA O STREAM DE ÁUDIO =====
// Esta rota será acessada pelo <audio src="/stream"> no seu HTML
app.get('/stream', (req, res) => {
    console.log('🎧 Requisição de stream recebida.');
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    // Inicia o FFmpeg com a URL do stream principal atual
    // A URL real do stream será determinada pela lógica de agendamento
    // e armazenada em `currentPlayingStream.url`
    if (currentPlayingStream.url) {
        startFfmpegStream(currentPlayingStream.url, res);
    } else {
        console.warn('⚠️ Nenhuma URL de stream principal definida para FFmpeg.');
        res.status(404).send('Nenhum stream de rádio ativo.');
    }
});

// ===== LISTA COMPLETA DE MENSAGENS DO GOOGLE DRIVE (CORRIGIDA) =====
// Esta lista é um cache das suas mensagens, com as duplicações removidas.
const mensagensCache = [
    { id: '1Z4ZZ_QhM82ivnbWg7c7zofCkGE6HuqJu', name: 'msg_010.mp3' },
    { id: '1v10QzlGw4gGsJgWgsI6Gx7u0YHGzAmZH', name: 'msg_009.mp3' },
    { id: '1nEiDvQ5-8RXWIO8btpqVMvEzJnL7IwpP', name: 'msg_008.mp3' },
    { id: '11LSjJO3r_dKMls2YOrxzRvbchoM-Eoz3', name: 'msg_007.mp3' },
    { id: '1vxw4yR4NcBfs-DCvktOSzsi7zvhiUkWh', name: 'msg_006.mp3' },
    { id: '13LaeViIDUK-IwZCALw-5mV5sHTYoQkiZ', name: 'msg_005.mp3' },
    { id: '1gFFmjUUNoqkdIHMGc-cYxP9SX6Zpp8v4', name: 'msg_004.mp3' },
    { id: '1N49UV49UgOX8MaYmCO0EJwN2VB1Izp3S', name: 'msg_003.mp3' },
    { id: '1f1xLhQWdCdLNCyHHnaHgH6zihHIE4gcv', name: 'msg_002.mp3' },
    { id: '118tRazLR0sUIks4E43HH9ggOB_VMC7Pl', name: 'msg_001.mp3' },
    { id: '1uX99frB_rnEU_uBD57u2WcdJaox4c6j_', name: 'Salmo 106.mp3' },
    { id: '1lVviofGAdqEWygzdFLd1emt57flF9W1M', name: 'Salmo 119.mp3' },
    { id: '1CLztJTfu0s8psYxpCVyQ-lti_lZTt6E7', name: 'Salmo 105.mp3' },
    { id: '1y4ES81ZUYH_ads_Y0R3B2Ww5hHUks88p', name: 'Salmo 107.mp3' },
    { id: '16v61m1k5tdKTZUBSucQkvhevBvhMuFTp', name: 'Salmo 78.mp3' },
    { id: '12ra2H5ucpEO7aqCwVoFogJOkp_7rwX5w', name: 'Salmo 117.mp3' },
    { id: '1AkPfoVZLmNofXx0wHNlpSsIiHSEalEIB', name: 'Salmo 131.mp3' },
    { id: '1yN8U5g4lODAEhqR7wKwXerPjoT4hNGWh', name: 'Salmo 134.mp3' },
    { id: '1BOb5GEiBhR9DeK2vLeF5CKn499v-jNG_', name: 'Salmo 121.mp3' },
    { id: '1i3TK4QZvfh_BN_WpOKrxufZoWfRl-0Iv', name: 'Salmo 128.mp3' },
    { id: '1ehj7_Oba7RtKaTBz0s3WOkZx0H4e4bYr', name: 'Salmo 133.mp3' },
    { id: '1L37pSgDdbEJOB71Rh9wU_F1JieX5uS_y', name: 'Salmo 127.mp3' },
    { id: '1i4VpP7lC7DuXHx7ggpdrESR_yIYyCT_8', name: 'Salmo 100.mp3' },
    { id: '1LlfKangFdPNuo3Hk32SI1Q12C323YTLy', name: 'Salmo 125.mp3' },
    { id: '1EBezglx-IfwK602bxrNkbmTADtQdWQZq', name: 'Salmo 114.mp3' },
    { id: '1fiTdtM7SCT0Bk0HboUv7YLlpOv6YGnCM', name: 'Salmo 93.mp3' },
    { id: '1h0pejzsa0msag3cPgZFfoHdxRD-VtEYl', name: 'Salmo 113.mp3' },
    { id: '1kkTNKs332_0e3c06IYHsbFauWMU7URzE', name: 'Salmo 126.mp3' },
    { id: '1n1gy4l9k6B6l5B_eXeaRHcb9895GOAD7', name: 'Salmo 120.mp3' },
    { id: '1D1edO6gqvUS9Eqw0Zm8SzrLa07Ac68Rc', name: 'Salmo 123.mp3' },
    { id: '1gF69TOjPdaSbm3R4OBuVw8glpdASlrFS', name: 'Salmo 150.mp3' },
    { id: '1_3urJGy0_j66Vmf8y2-2P0k0P87TOGeS', name: 'Salmo 124.mp3' },
    { id: '1j0_9NwY7KEctjj7fh5sn35sAsUr1HZAl', name: 'Salmo 129.mp3' },
    { id: '1j2jClOT6fEGMffd2mehNbYmcopmdplGB', name: 'Salmo 122.mp3' },
    { id: '1BwKCFU7FHI4PW4oBVQqUu1GaiAVID3Eo', name: 'Salmo 137.mp3' },
    { id: '1FNdZIxM8LO4LFdH0EsThYsElmbC-dhK8', name: 'Salmo 130.mp3' },
    { id: '16VECEsmwSs8gVuMj2IXpAVOQ1qaFIXyA', name: 'Salmo 142.mp3' },
    { id: '1tySpNqegPCjV2qI-hBpmavutvFIwDwqi', name: 'Salmo 149.mp3' },
    { id: '1-uelr59uvtKIK3ctyPzv9jBroFBvWP3v', name: 'Salmo 101.mp3' },
    { id: '1mVkLs2hZYAEiPkdW8iw4-oF5fh1wsVhg', name: 'Salmo 82.mp3' },
    { id: '1BTOwj2xHP0j4ppPMqdDYDZXd916cpuhd', name: 'Salmo 112.mp3' },
    { id: '1Rji9Ybuh2Kyz-1SpMrMRkqmBrrZ7uOml', name: 'Salmo 138.mp3' },
    { id: '1e-MZeWuu7n9xIu6UulFFA0Je4bKumZ4j', name: 'Salmo 111.mp3' },
    { id: '13Istud0Ruj7oKHHHbblLznAXpm_W0Zho', name: 'Salmo 146.mp3' },
    { id: '18FJOdANODiBo-vyYzsem9KwpyHZ3qi3k', name: 'Salmo 87.mp3' },
    { id: '1EZzacTP20mPeBoEucmZC65ivsVL-Ay5D', name: 'Salmo 110.mp3' },
    { id: '1t9_AYDKPVjS87wdmxdqQKS4s2AtlPA3F', name: 'Salmo 98.mp3' },
    { id: '1NxLbScmVCEbGN9rqB3WNmfCeqmTKV3A4', name: 'Salmo 141.mp3' },
    { id: '1JAqRW0pDm6XgDa8Lhdm2jI-cmqtDxKS8', name: 'Salmo 95.mp3' },
    { id: '1dvmlynb5yDVHcQxZnMIQ7UrbUHTgisev', name: 'Salmo 99.mp3' },
    { id: '1-m0huWoY2VZjxcmb0NAE6AuT29zU7oIh', name: 'Salmo 140.mp3' },
    { id: '1Z22hoepgWHjoCKkd5JUCOViIYRLUuO5F', name: 'Salmo 97.mp3' },
    { id: '1TWDRwqRDTBRwSSBiMHTw0GdXMwNBo24S', name: 'Salmo 76.mp3' },
    { id: '1fQe7QcMcoyfymh2k4N682tZVZ5jO02hV', name: 'Salmo 96.mp3' },
    { id: '1iIRJ121q9sk-uE2PQQL9uxmUEmiIPJsx', name: 'Salmo 143.mp3' },
    { id: '1EPWnB4wB69Ps53UORwfPbuKiVzQIKEbn', name: 'Salmo 84.mp3' },
    { id: '1eC6CqwimvrMydZGyXiEhRRV3XhwLkupv', name: 'Salmo 148.mp3' },
    { id: '17WDUcHHwDgzURL6Iyn7xsdpGjGc86Dn4', name: 'Salmo 147.mp3' },
    { id: '1i-aJU88g9GveRgRaPhQ43-HhkA_GM_Hn', name: 'Salmo 85.mp3' },
    { id: '1E9pmHkkFrZRTDXWTihqNIvkRJLrFMh9X', name: 'Salmo 91.mp3' }
];

// Função para selecionar uma mensagem aleatória
function selecionarMensagemAleatoria() {
    if (mensagensCache.length === 0) {
        console.warn('⚠️ Cache de mensagens vazio. Nenhuma mensagem para tocar.');
        return null;
    }
    const randomIndex = Math.floor(Math.random() * mensagensCache.length);
    return mensagensCache[randomIndex];
}

// Função para obter a URL de download direto do Google Drive
function getGoogleDriveDirectLink(fileId) {
    return `https://docs.google.com/uc?export=download&id=${fileId}`;
}

// Função para tocar uma mensagem
function tocarMensagem(mensagem, durationSeconds) {
    if (isPlayingMessage) {
        console.log('⏭️ Ignorando nova mensagem (já tocando uma).');
        return;
    }

    isPlayingMessage = true;
    console.log(`▶️ Tocando mensagem: ${mensagem.name} (${durationSeconds}s)`);
    io.emit('play-mensagem', {
        url: getGoogleDriveDirectLink(mensagem.id),
        description: mensagem.name,
        duration: durationSeconds
    });

    // Limpa qualquer timeout anterior para evitar conflitos
    if (messageTimeout) {
        clearTimeout(messageTimeout);
    }

    messageTimeout = setTimeout(() => {
        console.log('⏹️ Mensagem finalizada, retornando para a programação normal');
        isPlayingMessage = false;
        io.emit('stop-mensagem');
        checkStreamStatus(); // Verifica e retorna ao stream principal
    }, durationSeconds * 1000);
}

// Função para verificar e atualizar o stream principal
function checkStreamStatus() {
    if (isPlayingMessage) {
        console.log('⏭️ Ignorando mudança de stream (tocando mensagem)');
        return;
    }

    const now = new Date();
    const hora = now.getHours();
    const minuto = now.getMinutes();
    const diaSemana = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado

    let url = '';
    let descricao = '';
    let dia = '';

    switch (diaSemana) {
        case 0: dia = 'domingo'; break;
        case 1: dia = 'segunda'; break;
        case 2: dia = 'terca'; break;
        case 3: dia = 'quarta'; break;
        case 4: dia = 'quinta'; break;
        case 5: dia = 'sexta'; break;
        case 6: dia = 'sabado'; break;
    }

    // Lógica de agendamento
    // Domingo 8h30-9h45: Missa Rádio Marabá
    if (dia === 'domingo' && ((hora === 8 && minuto >= 30) || (hora === 9 && minuto < 45))) {
        url = RADIO_MARABA_URL;
        descricao = '⛪ Santa Missa Dominical - Rádio Marabá';
    }
    // Sábado 12h50-13h05: Voz do Pastor (Marabá)
    else if (dia === 'sabado' && ((hora === 12 && minuto >= 50) || (hora === 13 && minuto < 5))) {
        url = RADIO_MARABA_URL;
        descricao = '🎙️ Voz do Pastor - Rádio Marabá';
    }
    // Madrugada Clássica Erudita (00h10 - 03h00)
    else if ((hora === 0 && minuto >= 10) || (hora >= 1 && hora < 3)) {
        url = RADIO_CLASSICA_URL;
        descricao = '🎼 Madrugada Clássica Erudita';
        // Toca mensagem a cada 15 minutos durante a madrugada clássica
        if (minuto % 15 === 0 && minuto !== 0) { // Evita tocar no minuto 00:00
            const msg = selecionarMensagemAleatoria();
            if (msg) tocarMensagem(msg, 60); // Mensagem de 60 segundos
        }
    }
    // Programação Principal: Rádio Voz do Coração Imaculado
    else {
        url = RADIO_VOZ_IMACULADO_URL;
        descricao = '🎵 Rádio Voz do Coração Imaculado';
    }

    // Verifica se o stream mudou
    if (currentPlayingStream.url !== url) {
        currentPlayingStream = { url, description: descricao };
        console.log(`▶️ Stream: ${descricao}`);
        io.emit('play-stream', currentPlayingStream); // Notifica os clientes sobre a mudança
    } else if (currentPlayingStream.description !== descricao) {
        // Atualiza apenas a descrição se a URL for a mesma (ex: para mensagens)
        currentPlayingStream.description = descricao;
        io.emit('update-description', currentPlayingStream.description);
    }
}

// Agendamento de mensagens diárias
cron.schedule('0 10 * * *', () => { // 10:00 AM
    console.log('📢 [10h00] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('40 12 * * *', () => { // 12:40 PM
    console.log('📢 [12h40] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('52 13 * * *', () => { // 13:52 PM
    console.log('📢 [13h52] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('0 15 * * *', () => { // 15:00 PM
    console.log('📢 [15h00] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('0 18 * * *', () => { // 18:00 PM
    console.log('📢 [18h00] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('0 20 * * *', () => { // 20:00 PM
    console.log('📢 [20h00] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

cron.schedule('0 22 * * *', () => { // 22:00 PM
    console.log('📢 [22h00] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) tocarMensagem(msg, 60);
}, { timezone: "America/Sao_Paulo" });

// Agendamento para verificar o status do stream a cada minuto
cron.schedule('* * * * *', () => {
    checkStreamStatus();
}, { timezone: "America/Sao_Paulo" });

// Endpoint para testar o agendamento de mensagens
app.get('/tocar-mensagem-teste', (req, res) => {
    console.log('📢 [Teste] Mensagem');
    const msg = selecionarMensagemAleatoria();
    if (msg) {
        tocarMensagem(msg, 60);
        res.send(`✅ Mensagem: ${msg.name}`);
    } else {
        res.send('⚠️ Nenhuma mensagem disponível');
    }
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║  🎙️  WebRádio Paróquia NSA                       ║
║  ✅ Servidor ativo na porta ${PORT}                 ║
║  📂 Google Drive: ${GOOGLE_DRIVE_FOLDER_ID}        ║
║  📊 Mensagens carregadas: ${mensagensCache.length}         ║
║  🎵 Rádio Principal: Voz do Coração Imaculado    ║
║  🎼 Clássica: 00h10-03h00 (msgs a cada 15min)   ║
║  ⛪ Domingo: Missa Marabá 8h30-9h45             ║
║  📻 Sábado: Voz do Pastor 12h50-13h05           ║
║  ⏰ Mensagens diárias: 10h, 12h40, 13h52...     ║
╚════════════════════════════════════════════════════╝
    `);
    // Inicializa o stream principal ao iniciar o servidor
    checkStreamStatus();
});
