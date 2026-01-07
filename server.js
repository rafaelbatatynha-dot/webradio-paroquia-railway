// server.js – TESTE CRÍTICO: Alternância de stream a cada 2 minutos

const express = require('express');
const http = require('http');
const https = require('https'); // Necessário para streams HTTPS
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ---------------------- STREAMS SIMPLIFICADOS ----------------------
const STREAMS = {
    imaculado: {
        url: "http://r13.ciclano.io:9033/live",
        description: "Voz do Coração Imaculado"
    },
    classica: {
        url: "https://stream.srg-ssr.ch/m/rsc_de/mp3_128",
        description: "Música Clássica"
    }
};

let currentStream = STREAMS.imaculado; // Começa com Imaculado

// ---------------------- LOG ----------------------
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------- FUNÇÃO DE TROCA DE STREAM ----------------------
function switchStream() {
    if (currentStream === STREAMS.imaculado) {
        currentStream = STREAMS.classica;
    } else {
        currentStream = STREAMS.imaculado;
    }
    log(`Stream trocado para: ${currentStream.description}`);
}

// ---------------------- AGENDAMENTO CRON (A CADA 2 MINUTOS) ----------------------
cron.schedule('*/2 * * * *', () => {
    log("CRON: Disparado agendamento de troca de stream.");
    switchStream();
});

log("Agendamento de troca de stream a cada 2 minutos carregado.");

// ---------------------- ROTA /stream ----------------------
app.get("/stream", (req, res) => {
    try {
        const url = currentStream.url;
        const target = new URL(url);
        const client = target.protocol === "https:" ? https : http; // Usa https para URLs HTTPS

        const reqS = client.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === "https:" ? 443 : 80),
            path: target.pathname + target.search,
            method: "GET",
            headers: { "User-Agent": "Mozilla" } // Importante para alguns streams
        }, streamRes => {
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            streamRes.pipe(res);
        });

        reqS.on('error', (e) => {
            log(`Erro na requisição do stream: ${e.message}`);
            res.status(500).send("Erro ao carregar stream.");
        });

        reqS.end();

    } catch (err) {
        log(`Erro geral no /stream: ${err.message}.`);
        res.status(500).send("Erro stream");
    }
});

// ---------------------- ROTA /health ----------------------
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        currentStream: currentStream.description,
        serverTimeUTC: new Date().toISOString()
    });
});

// ---------------------- INICIALIZAÇÃO DO SERVIDOR ----------------------
server.listen(PORT, "0.0.0.0", () => {
    log(`Servidor de teste iniciado na porta ${PORT}.`);
    log(`Stream inicial: ${currentStream.description}`);
});
