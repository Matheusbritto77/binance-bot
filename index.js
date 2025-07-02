// Este é um bot de scalping avançado que escaneia múltiplos pares de moedas.

// 1. Importa as bibliotecas necessárias
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA } = require('technicalindicators');
const fs = require('fs');

// --- ATENÇÃO: DADOS DE AUTENTICAÇÃO ---
const apiKey = '';
const apiSecret = '';

// --- CARREGA CONFIGURAÇÕES DO ARQUIVO JSON ---
const STRATEGY_CONFIG = JSON.parse(fs.readFileSync('config.json'));

// --- CORES E CLIENTE BINANCE ---
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
const client = Binance({ apiKey, apiSecret, timeSync: true });

// --- ESTADO GLOBAL DO BOT (AGORA UM OBJETO PARA MÚLTIPLOS SÍMBOLOS) ---
let botState = {}; // Ex: { 'SOLUSDT': { candles: [], hasPosition: false, ... }, 'ADAUSDT': { ... } }

// =================================================================================================
// FUNÇÃO PRINCIPAL E CONTROLE DO BOT
// =================================================================================================
async function main() {
    showHeader(`Bot Scanner - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        console.log('Verificando saldo inicial...');
        const accountInfo = await client.accountInfo();
        const usdtBalance = parseFloat(accountInfo.balances.find(b => b.asset === STRATEGY_CONFIG.quoteAsset)?.free || '0');
        if (usdtBalance < 11) {
            console.log(colors.red, `❌ Saldo de ${STRATEGY_CONFIG.quoteAsset} (${usdtBalance.toFixed(2)}) é muito baixo para iniciar.`, colors.reset);
            return;
        }

        console.log('Iniciando monitoramento de múltiplos pares...');
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            await initializeSymbol(symbol);
        }
        console.log(colors.yellow, "\nO bot está operando em todos os pares. Pressione CTRL + C para parar.", colors.reset);
    } catch (error) {
        handleApiError(error);
        process.exit(1);
    }
}

async function initializeSymbol(symbol) {
    console.log(`[${symbol}] Buscando histórico de candles...`);
    // Inicializa o estado para este símbolo específico
    botState[symbol] = {
        websocket: null,
        candles: [],
        hasPosition: false,
        lastBuyPrice: 0,
    };

    const historicalCandles = await client.candles({ symbol, interval: STRATEGY_CONFIG.interval, limit: STRATEGY_CONFIG.emaPeriod + 50 });
    botState[symbol].candles = historicalCandles;

    // Inicia um WebSocket para cada símbolo
    botState[symbol].websocket = client.ws.candles(symbol, STRATEGY_CONFIG.interval, (candle) => {
        if (candle.isFinal) {
            handleCandle(candle);
        }
    });
    console.log(colors.green, `[${symbol}] Monitoramento em tempo real iniciado.`);
}

/**
 * Função central que recebe todos os candles e direciona para a análise correta.
 */
async function handleCandle(candle) {
    const symbol = candle.symbol;
    console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] Preço: ${parseFloat(candle.close).toFixed(4)}`);
    
    const state = botState[symbol];
    state.candles.push(candle);
    if (state.candles.length > STRATEGY_CONFIG.emaPeriod + 50) state.candles.shift();
    
    const closePrices = state.candles.map(c => parseFloat(c.close));
    const volumes = state.candles.map(c => parseFloat(c.volume));
    const macdInput = { values: closePrices, ...STRATEGY_CONFIG.macd };

    const indicators = {
        rsi: RSI.calculate({ period: STRATEGY_CONFIG.rsiPeriod, values: closePrices }).pop(),
        ema: EMA.calculate({ period: STRATEGY_CONFIG.emaPeriod, values: closePrices }).pop(),
        macd: MACD.calculate(macdInput).pop(),
        volume: volumes[volumes.length - 1],
        volumeSma: SMA.calculate({ period: STRATEGY_CONFIG.volumeSmaPeriod, values: volumes }).pop(),
    };
    
    console.log(`  [${symbol}] Indicadores: RSI=${indicators.rsi.toFixed(2)} | EMA=${indicators.ema.toFixed(2)} | MACD Hist=${indicators.macd?.histogram.toFixed(4)}`);
    await runTradingStrategy(symbol, parseFloat(candle.close), indicators);
}

// =================================================================================================
// LÓGICA DE TRADING (AGORA RECEBE O SÍMBOLO COMO PARÂMETRO)
// =================================================================================================
async function runTradingStrategy(symbol, price, indicators) {
    const { rsiOversold, rsiOverbought, stopLossPercent, takeProfitPercent } = STRATEGY_CONFIG;
    const { rsi, ema, macd, volume, volumeSma } = indicators;
    const symbolState = botState[symbol];

    if (symbolState.hasPosition) {
        const { lastBuyPrice } = symbolState;
        const stopLossPrice = lastBuyPrice * (1 - (stopLossPercent / 100));
        const takeProfitPrice = lastBuyPrice * (1 + (takeProfitPercent / 100));
        let sellReason = null;

        if (price <= stopLossPrice) sellReason = `STOP-LOSS`;
        else if (price >= takeProfitPrice) sellReason = `TAKE-PROFIT`;
        else if (rsi > rsiOverbought) sellReason = `SINAL RSI`;

        if (sellReason) {
            console.log(colors.red, `\n[${symbol}] 📉 SINAL DE VENDA! Motivo: ${sellReason}`);
            await executeSellOrder(symbol, price, sellReason);
        } else {
            console.log(`  [${symbol}] Posição aberta. Aguardando venda... Alvo: ${takeProfitPrice.toFixed(4)} | Stop: ${stopLossPrice.toFixed(4)}`);
        }
    } else {
        const isRsiLow = rsi < rsiOversold;
        const isAboveEma = price > ema;
        const isMacdPositive = macd?.histogram > 0;
        const isVolumeHigh = volume > volumeSma;

        console.log(`  [${symbol}] Analisando Compra: RSI? ${isRsiLow} | EMA? ${isAboveEma} | MACD? ${isMacdPositive} | Vol? ${isVolumeHigh}`);
        if (isRsiLow && isAboveEma && isMacdPositive && isVolumeHigh) {
            console.log(colors.green, `\n[${symbol}] 📈 SINAL DE COMPRA CONFIRMADO!`);
            await executeBuyOrder(symbol);
        }
    }
}

// =================================================================================================
// FUNÇÕES DE EXECUÇÃO DE ORDEM (AGORA RECEBEM O SÍMBOLO)
// =================================================================================================
async function executeBuyOrder(symbol) {
    const { tradeAmountPercent, quoteAsset } = STRATEGY_CONFIG;
    try {
        const accountInfo = await client.accountInfo();
        const usdtBalance = parseFloat(accountInfo.balances.find(b => b.asset === quoteAsset).free);
        const tradeAmount = usdtBalance * (tradeAmountPercent / 100);

        if (tradeAmount < 11) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Valor da ordem (${tradeAmount.toFixed(2)}) é menor que o mínimo.`);
            return;
        }
        console.log(`  [${symbol}] Executando ordem de compra a mercado de ${tradeAmount.toFixed(2)} ${quoteAsset}...`);
        const order = await client.order({ symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: tradeAmount.toFixed(2) });
        
        const symbolState = botState[symbol];
        symbolState.hasPosition = true;
        symbolState.lastBuyPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty);
        logOrderExecution(order, 'BUY', symbolState.lastBuyPrice);
    } catch (error) { handleApiError(error); }
}

async function executeSellOrder(symbol, price, reason) {
    const baseAsset = symbol.replace(STRATEGY_CONFIG.quoteAsset, '');
    try {
        const accountInfo = await client.accountInfo();
        const assetBalance = parseFloat(accountInfo.balances.find(b => b.asset === baseAsset).free);
        if (assetBalance * price < 11) return;

        console.log(`  [${symbol}] Executando ordem de venda a mercado de ${assetBalance.toFixed(4)} ${baseAsset}...`);
        const order = await client.order({ symbol, side: 'SELL', type: 'MARKET', quantity: assetBalance.toFixed(4) });
        
        const symbolState = botState[symbol];
        logOrderExecution(order, 'SELL', symbolState.lastBuyPrice, price, reason);
        symbolState.hasPosition = false;
        symbolState.lastBuyPrice = 0;
    } catch (error) { handleApiError(error); }
}

// =================================================================================================
// FUNÇÕES AUXILIARES
// =================================================================================================
function logOrderExecution(order, side, buyPrice, sellPrice, reason) {
    const pnl = side === 'SELL' ? (sellPrice - buyPrice) * parseFloat(order.executedQty) : 0;
    const color = side === 'BUY' ? colors.green : (pnl > 0 ? colors.green : colors.red);
    const title = side === 'BUY' ? `ORDEM DE COMPRA EXECUTADA!` : `ORDEM DE VENDA EXECUTADA! (${reason})`;
    
    console.log(color, `  [${order.symbol}] ------------------------------------------`);
    console.log(`  [${order.symbol}] ✅ ${title}`);
    console.log(`  - Quantidade: ${parseFloat(order.executedQty).toFixed(4)}`);
    console.log(`  - Valor Total: ${parseFloat(order.cummulativeQuoteQty).toFixed(2)} USDT`);
    if (side === 'SELL') console.log(`  - Lucro/Prejuízo (P&L): ${pnl.toFixed(2)} USDT`);
    console.log(`  [${order.symbol}] ------------------------------------------`, colors.reset);
}
function showHeader(title) { console.clear(); console.log(colors.cyan, `================== ${title} ==================\n`, colors.reset); }
function handleApiError(error) { console.error(colors.red, '\n❌ Ocorreu um erro:', `[${error.code || 'S/C'}] ${error.message}`, colors.reset); }
function gracefulShutdown() {
    console.log(colors.yellow, "\nRecebido sinal de encerramento...");
    for (const symbol in botState) {
        if (botState[symbol].websocket) {
            console.log(`[${symbol}] Fechando conexão WebSocket...`);
            botState[symbol].websocket();
        }
    }
    console.log("Bot encerrado de forma limpa.", colors.reset);
    process.exit(0);
}

// --- INÍCIO DO PROGRAMA ---
process.on('SIGINT', gracefulShutdown);
main().catch(error => { console.error(colors.red, '❌ Erro fatal:', error, colors.reset); process.exit(1); });