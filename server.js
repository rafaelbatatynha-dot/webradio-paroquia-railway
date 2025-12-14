const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors'); // Importa o módulo CORS

const app = express();

// ===== CONFIGURAÇÃO DO CORS =====
// Lista de origens permitidas para acessar seu servidor
const allowedOrigins = [
    'https://www.paroquiaauxiliadorairai.com.br',
    'https://webradio-paroquia.onrender.com',
    'http://localhost:3000' // Para testes locais
];

// Configuração do CORS para o Express (rotas HTTP)
app.use(cors({
    origin: function (origin, callback) {
        // Permite requisições sem 'origin' (ex: de ferramentas como Postman ou requisições do mesmo servidor)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'A política de CORS para esta origem não permite acesso.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));

// Middleware para ignorar o aviso do ngrok (se estiver usando)
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

const server = http.createServer(app);

// ===== CONFIGURAÇÃO DO SOCKET.IO COM CORS =====
// É CRÍTICO que o Socket.IO tenha sua própria configuração de CORS
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins, // Permite as mesmas origens definidas acima
        methods: ["GET", "POST"], // Métodos HTTP permitidos
        credentials: true // Permite o envio de cookies de credenciais
    }
});

const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÃO DO GOOGLE DRIVE =====
const GOOGLE_DRIVE_FOLDER_ID = '1fxtCinZOfb74rWma-nSI_IUNgCSvrUS2';
// ========================================

app.use(express.static('public'));

// Variável global para armazenar o stream atual e sua descrição
let currentPlayingStream = {
    url: '',
    description: ''
};

// ===== PROXY PARA STREAMS =====
// Este proxy é essencial para contornar problemas de CORS e mixed content
// ao tentar reproduzir streams de áudio de diferentes origens.
app.get('/proxy-stream/:tipo', (req, res) => {
    const tipo = req.params.tipo;
    let streamUrl = '';

    if (tipo === 'vozimaculado') {
        streamUrl = 'http://r13.ciclano.io:9033/live';
    } else if (tipo === 'maraba') {
        streamUrl = 'https://streaming.speedrs.com.br/radio/8010/maraba';
    } else if (tipo === 'classica') {
        streamUrl = 'https://livestreaming-node-2.srg-ssr.ch/srgssr/rsc_de/mp3/128';
    } else if (tipo === 'ametista-fm') {
        // Usando o link do portal radios.com.br diretamente, como solicitado
        streamUrl = 'https://www.radios.com.br/aovivo/radio-ametista-885-fm/16128';
    }

    if (!streamUrl) {
        return res.status(400).send('Stream inválido ou não configurado');
    }

    // Usando axios para lidar com o stream, pois ele pode lidar melhor com redirecionamentos
    // e simular um navegador para acessar o portal.
    axios({
        method: 'get',
        url: streamUrl,
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36', // Simula um navegador completo
            'Accept': 'audio/mpeg, audio/aac, audio/ogg, audio/*;q=0.9, application/ogg;q=0.7, video/*;q=0.9, */*;q=0.8' // Aceita tipos de áudio
        }
    }).then(response => {
        // Tenta inferir o Content-Type do stream real se houver um redirecionamento ou se o portal retornar um tipo de áudio
        const contentType = response.headers['content-type'] || 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*'); // Permite que qualquer origem acesse este proxy
        response.data.pipe(res);
    }).catch(err => {
        console.error(`Erro no proxy para ${tipo} (${streamUrl}):`, err.message);
        res.status(500).send('Erro no proxy ao tentar conectar ao stream');
        // Em caso de erro no proxy, tentar voltar para a Voz Imaculada
        if (currentPlayingStream.url !== '/proxy-stream/vozimaculado') {
            console.log('Tentando fallback para Voz do Coração Imaculado devido a erro no stream.');
            io.emit('play-stream', { url: '/proxy-stream/vozimaculado', descricao: '🎵 Rádio Voz do Coração Imaculado (Fallback)' });
        }
    });
});

// ===== PROXY PARA MENSAGENS (Google Drive) =====
// Essencial para baixar arquivos do Google Drive sem bloqueios de CORS
app.get('/proxy-mensagem/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;

    console.log(`📥 Baixando mensagem via proxy: ${fileId}`);

    axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0' // Simula um navegador para evitar bloqueios
        }
    }).then(response => {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Access-Control-Allow-Origin', '*');
        response.data.pipe(res);
    }).catch(err => {
        console.error('❌ Erro ao baixar mensagem via proxy:', err.message);
        res.status(500).send('Erro ao baixar mensagem do Google Drive');
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ===== WEBSOCKET =====
io.on('connection', (socket) => {
    console.log('✅ Ouvinte conectado');
    io.emit('ouvintes', { total: io.engine.clientsCount });

    // Envia o stream atual para o novo ouvinte ao conectar
    if (currentPlayingStream.url) {
        socket.emit('play-stream', currentPlayingStream);
    }

    socket.on('disconnect', () => {
        console.log('❌ Ouvinte desconectado');
        io.emit('ouvintes', { total: io.engine.clientsCount });
    });
});

// ===== LISTA DE MENSAGENS (GOOGLE DRIVE) =====
// Manteremos esta lista por enquanto, mas será substituída pela importação automática
let listaMensagens = [
    "1Z4ZZ_QhM82ivnbWg7c7zofCkGE6HuqJu", // msg_010.mp3
    "1v10QzlGw4gGsJgWgsI6Gx7u0YHGzAmZH", // msg_009.mp3
    "1nEiDvQ5-8RXWIO8btpqVMvEzJnL7IwpP", // msg_008.mp3
    "11LSjJO3r_dKMls2YOrxzRvbchoM-Eoz3", // msg_007.mp3
    "1vxw4yR4NcBfs-DCvktOSzsi7zvhiUkWh", // msg_006.mp3
    "13LaeViIDUK-IwZCALw-5mV5sHTYoQkiZ", // msg_005.mp3
    "1gFFmjUUNoqkdIHMGc-cYxP9SX6Zpp8v4", // msg_004.mp3
    "1N49UV49UgOX8MaYmCO0EJwN2VB1Izp3S", // msg_003.mp3
    "1f1xLhQWdCdLNCyHHnaHgH6zihHIE4gcv", // msg_002.mp3
    "118tRazLR0sUIks4E43HH9ggOB_VMC7Pl", // msg_001.mp3
];

// ===== TOCAR MENSAGEM ALEATÓRIA =====
function tocarMensagemAleatoria() {
    if (listaMensagens.length === 0) {
        console.log('⚠️ Nenhuma mensagem disponível ainda');
        io.emit('aviso', { texto: 'Nenhuma mensagem cadastrada ainda' });
        return;
    }

    const escolhida = listaMensagens[Math.floor(Math.random() * listaMensagens.length)];
    console.log('🎙️ Tocando mensagem do Cônego Rafael');

    const urlMensagem = `/proxy-mensagem/${escolhida}`;

    io.emit('play-mensagem', {
        arquivo: urlMensagem,
        duracao: 60 // Duração padrão de 1 minuto
    });
}

// ===== HORÁRIOS FIXOS DAS MENSAGENS DIÁRIAS =====
cron.schedule('0 10 * * *', () => { console.log('📢 [10h] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('40 12 * * *', () => { console.log('📢 [12h40] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('52 13 * * *', () => { console.log('📢 [13h52] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('30 14 * * *', () => { console.log('📢 [14h30] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('50 15 * * *', () => { console.log('📢 [15h50] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('20 16 * * *', () => { console.log('📢 [16h20] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('13 17 * * *', () => { console.log('📢 [17h13] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('55 18 * * *', () => { console.log('📢 [18h55] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('0 20 * * *', () => { console.log('📢 [20h] Mensagem programada'); tocarMensagemAleatoria(); });
cron.schedule('50 23 * * *', () => { console.log('📢 [23h50] Mensagem programada'); tocarMensagemAleatoria(); });

// ===== MENSAGENS A CADA 30 MIN NA MADRUGADA (01h-05h) =====
cron.schedule('0,30 1-4 * * *', () => {
    console.log('📢 [Madrugada] Mensagem programada');
    tocarMensagemAleatoria();
});

// ===== PROGRAMAÇÃO AUTOMÁTICA DE STREAMS =====
function playStreamPorHorario() {
    const agora = new Date();
    const hora = agora.getHours();
    const minuto = agora.getMinutes();
    const dia = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'][agora.getDay()];

    let url = '';
    let descricao = '';

    // Domingo 8h30-9h45: Missa Rádio Marabá
    if (dia === 'domingo' && ((hora === 8 && minuto >= 30) || (hora === 9 && minuto < 45))) {
        url = '/proxy-stream/maraba'; // Usa o proxy
        descricao = '⛪ Santa Missa Dominical - Rádio Marabá';
    }
    // Sábado 12h50-13h05: Voz do Pastor (Marabá)
    else if (dia === 'sabado' && ((hora === 12 && minuto >= 50) || (hora === 13 && minuto <= 5))) {
        url = '/proxy-stream/maraba'; // Usa o proxy
        descricao = '📻 Voz do Pastor - Rádio Marabá';
    }
    // Sábado 19h00-20h30: Missa Rádio Ametista FM (via portal radios.com.br)
    else if (dia === 'sabado' && ((hora === 19 && minuto >= 0) || (hora === 20 && minuto < 30))) {
        url = '/proxy-stream/ametista-fm'; // Usa o proxy para o link do portal
        descricao = '🙏 Santa Missa de Sábado - Rádio Ametista FM';
        // A detecção de silêncio será implementada no cliente para este stream
    }
    // Madrugada Clássica 01h-05h
    else if (hora >= 1 && hora < 5) { // Das 01:00 (inclusive) até 04:59 (inclusive)
        url = '/proxy-stream/classica'; // Usa o proxy
        descricao = '🎼 Madrugada Clássica Erudita';
    }
    // Restante do tempo: Rádio Voz do Coração Imaculado
    else {
        url = '/proxy-stream/vozimaculado'; // Usa o proxy
        descricao = '🎵 Rádio Voz do Coração Imaculado';
    }

    // Só emite se o stream mudou ou se é a primeira vez
    if (currentPlayingStream.url !== url || currentPlayingStream.description !== descricao) {
        currentPlayingStream = { url, description: descricao };
        io.emit('play-stream', currentPlayingStream);
        console.log(`▶️ Trocando para: ${descricao} (${url})`);
    }
}

// Verificar e atualizar o stream a cada minuto
cron.schedule('* * * * *', playStreamPorHorario);

// Iniciar a programação automática 2 segundos após o servidor ligar
setTimeout(() => {
    console.log('🎵 Iniciando programação automática...');
    playStreamPorHorario();
}, 2000);

// ===== ROTAS DE TESTE (para você testar manualmente) =====
app.get('/teste-mensagem', (req, res) => {
    tocarMensagemAleatoria();
    res.send('✅ Mensagem disparada (60 segundos)');
});

app.get('/teste-stream/:tipo', (req, res) => {
    const tipo = req.params.tipo;
    let url = '';
    let descricao = '';

    if (tipo === 'maraba') {
        url = '/proxy-stream/maraba';
        descricao = 'Rádio Marabá';
    } else if (tipo === 'vozimaculado') {
        url = '/proxy-stream/vozimaculado';
        descricao = 'Rádio Voz do Coração Imaculado';
    } else if (tipo === 'classica') {
        url = '/proxy-stream/classica';
        descricao = 'Música Clássica';
    } else if (tipo === 'ametista-fm') {
        url = '/proxy-stream/ametista-fm';
        descricao = 'Rádio Ametista FM';
    } else {
        return res.status(400).send('Tipo de stream de teste inválido.');
    }

    currentPlayingStream = { url, description: descricao }; // Atualiza o stream atual
    io.emit('play-stream', currentPlayingStream);
    res.send(`▶️ Testando: ${descricao}`);
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║  🎙️  WebRádio Paróquia NSA                       ║
║  ✅ Servidor ativo na porta ${PORT}                 ║
║  📂 Google Drive ID: ${GOOGLE_DRIVE_FOLDER_ID}     ║
║  ⏰ Mensagens: 10h, 12h40, 13h52, 14h30,         ║
║              15h50, 16h20, 17h13, 18h55,         ║
║              20h, 23h50                          ║
║  🌙 Madrugada (01h-05h): Música Clássica + Mensagens ║
║  ⛪ Sábado (19h-20h30): Rádio Ametista FM         ║
╚════════════════════════════════════════════════════╝
    `);
});
