# 🤖 Binance Futures Trading Bot v5.0

> **Bot de Trading Inteligente para Binance Futures com IA Integrada**

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-6.0+-blue.svg)](https://mongodb.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 📋 Índice

- [🎯 Visão Geral](#-visão-geral)
- [🏗️ Arquitetura do Sistema](#️-arquitetura-do-sistema)
- [🚀 Funcionalidades](#-funcionalidades)
- [📊 Estratégias de Trading](#-estratégias-de-trading)
- [🤖 Módulo de IA](#-módulo-de-ia)
- [💾 Sistema de Persistência](#-sistema-de-persistência)
- [⚙️ Configuração](#️-configuração)
- [🔧 Instalação](#-instalação)
- [📈 Uso](#-uso)
- [🔍 Monitoramento](#-monitoramento)
- [⚠️ Avisos Importantes](#️-avisos-importantes)
- [📝 Logs e Debugging](#-logs-e-debugging)
- [🛠️ Desenvolvimento](#️-desenvolvimento)

---

## 🎯 Visão Geral

O **Binance Futures Trading Bot v5.0** é um sistema avançado de trading automatizado que combina estratégias tradicionais de análise técnica com inteligência artificial para operar no mercado de futuros da Binance.

### ✨ Características Principais

- **🤖 IA Integrada**: Módulo de machine learning próprio para análise preditiva
- **📊 Multi-Timeframe**: Análise simultânea em 4 timeframes (1m, 5m, 15m, 1h)
- **🔄 Tempo Real**: WebSockets para dados em tempo real
- **💾 Persistência Robusta**: MongoDB + fallback JSON
- **🎯 3 Estratégias**: Trend Following, Mean Reversion, Breakout
- **🛡️ Gestão de Risco**: Stop Loss, Take Profit e invalidação automática
- **📈 Detecção Automática**: Novos símbolos são detectados e processados automaticamente

---

## 🏗️ Arquitetura do Sistema

```mermaid
graph TB
    subgraph "🌐 Binance API"
        API[Binance REST API]
        WS[Binance WebSocket]
    end
    
    subgraph "🤖 Bot Principal (index.js)"
        MAIN[Main Controller]
        STRAT[Strategy Engine]
        POS[Position Manager]
    end
    
    subgraph "📊 Módulos Especializados"
        AI[AI Module<br/>aiModule.js]
        WS_SVC[WebSocket Service<br/>websocketService.js]
        HTTP[HTTP Data Service<br/>dataHttp.js]
        DB[Database Service<br/>database.js]
    end
    
    subgraph "💾 Persistência"
        MONGO[(MongoDB)]
        JSON[(JSON Files)]
    end
    
    subgraph "📈 Estratégias"
        TF[Trend Following]
        MR[Mean Reversion]
        BO[Breakout]
    end
    
    API --> HTTP
    WS --> WS_SVC
    HTTP --> DB
    WS_SVC --> MAIN
    MAIN --> STRAT
    STRAT --> TF
    STRAT --> MR
    STRAT --> BO
    MAIN --> AI
    MAIN --> POS
    DB --> MONGO
    DB --> JSON
    AI --> DB
    HTTP --> AI
```

### 🔄 Fluxo de Dados

```mermaid
sequenceDiagram
    participant B as Bot
    participant WS as WebSocket
    participant AI as IA Module
    participant DB as Database
    participant API as Binance API
    
    B->>DB: Carrega dados históricos
    B->>WS: Inicia WebSockets
    WS->>B: Dados em tempo real
    B->>AI: Coleta dados para treinamento
    B->>B: Analisa indicadores
    B->>AI: Solicita previsão
    AI->>B: Retorna sinal
    B->>B: Toma decisão de trading
    B->>API: Executa ordem (se aplicável)
    B->>DB: Salva dados atualizados
```

---

## 🚀 Funcionalidades

### 🎯 Sistema de Decisão Inteligente

O bot utiliza uma **arquitetura híbrida** que combina:

1. **📊 Estratégias Tradicionais**: Base da decisão
2. **🤖 IA como Confirmação**: Filtro de qualidade
3. **🔄 Confluência**: Só executa quando há concordância

```mermaid
graph LR
    subgraph "📊 Estratégias Tradicionais"
        TF[Trend Following]
        MR[Mean Reversion]
        BO[Breakout]
    end
    
    subgraph "🤖 IA Module"
        AI[AI Prediction]
    end
    
    subgraph "🎯 Decisão Final"
        DEC[Decision Engine]
    end
    
    TF --> DEC
    MR --> DEC
    BO --> DEC
    AI --> DEC
    DEC --> EXEC[Execute Trade]
```

### 🔍 Detecção Automática de Novos Símbolos

```mermaid
graph TD
    A[Inicialização] --> B[Verifica symbolsToWatch]
    B --> C{Símbolo tem dados?}
    C -->|Não| D[Adiciona à lista de atualização]
    C -->|Sim| E[Carrega dados existentes]
    D --> F[Busca dados via HTTP]
    F --> G[Salva no MongoDB]
    G --> H[Treina IA]
    E --> I[Continua operação]
    H --> I
```

---

## 📊 Estratégias de Trading

### 1. 🚀 Trend Following (Seguimento de Tendência)

**Objetivo**: Identificar e seguir tendências de mercado

**Indicadores**:
- EMA 200 (confirmação de tendência)
- RSI 14 (momentum)
- MACD (confirmação adicional)

**Sinais**:
- **LONG**: Preço > EMA200 + RSI < 35 (sobrevendido)
- **SHORT**: Preço < EMA200 + RSI > 65 (sobrecomprado)

**Configuração**:
```json
{
  "trendFollowing": {
    "enabled": true,
    "emaPeriod": 200,
    "rsiPeriod": 14,
    "rsiOversold": 35,
    "rsiOverbought": 65,
    "takeProfitPercent": 5,
    "stopLossPercent": 2.5
  }
}
```

### 2. 🔄 Mean Reversion (Reversão à Média)

**Objetivo**: Operar contra movimentos extremos

**Indicadores**:
- Bollinger Bands (20, 2)
- RSI 14

**Sinais**:
- **LONG**: Preço < BB Lower + RSI < 30
- **SHORT**: Preço > BB Upper + RSI > 70

**Configuração**:
```json
{
  "meanReversion": {
    "enabled": true,
    "bollingerPeriod": 20,
    "bollingerStdDev": 2,
    "rsiOversold": 30,
    "rsiOverbought": 70,
    "takeProfitPercent": 2,
    "stopLossPercent": 1
  }
}
```

### 3. 💥 Breakout (Rompimento)

**Objetivo**: Capturar movimentos de rompimento

**Indicadores**:
- Bollinger Bands (20, 2)
- Volume SMA (20)

**Sinais**:
- **LONG**: Preço > BB Upper + Volume > 2x SMA
- **SHORT**: Preço < BB Lower + Volume > 2x SMA

**Configuração**:
```json
{
  "breakout": {
    "enabled": true,
    "bollingerPeriod": 20,
    "bollingerStdDev": 2,
    "volumeSmaPeriod": 20,
    "minVolumeSpike": 2,
    "takeProfitPercent": 3,
    "stopLossPercent": 1.5
  }
}
```

---

## 🤖 Módulo de IA

### 🧠 Arquitetura da IA

O módulo utiliza um **Perceptron Simplificado** com as seguintes características:

```mermaid
graph LR
    subgraph "📊 Features de Entrada"
        F1[Preço: Open, High, Low, Close]
        F2[Volume]
        F3[Indicadores: RSI, EMA, BB]
        F4[Variações: Price Change, Volume Change]
    end
    
    subgraph "🧠 Modelo IA"
        N1[Neurônio 1]
        N2[Neurônio 2]
        N3[Neurônio 3]
    end
    
    subgraph "🎯 Saída"
        OUT[LONG/SHORT/HOLD]
    end
    
    F1 --> N1
    F2 --> N2
    F3 --> N3
    F4 --> N1
    N1 --> OUT
    N2 --> OUT
    N3 --> OUT
```

### 🔄 Processo de Treinamento

```mermaid
graph TD
    A[Coleta de Dados] --> B[Normalização]
    B --> C[Treinamento]
    C --> D[Validação]
    D --> E{Performance OK?}
    E -->|Não| C
    E -->|Sim| F[Salva Modelo]
    F --> G[IA Pronta]
```

### 📊 Features Utilizadas

| Feature | Descrição | Normalização |
|---------|-----------|--------------|
| `open`, `high`, `low`, `close` | Preços OHLC | Min-Max |
| `volume` | Volume da vela | Min-Max |
| `rsi` | RSI 14 | Min-Max |
| `ema` | EMA 200 | Min-Max |
| `bb_upper`, `bb_lower`, `bb_middle` | Bollinger Bands | Min-Max |
| `price_change_1m` | Variação de preço | Min-Max |
| `volume_change_1m` | Variação de volume | Min-Max |

---

## 💾 Sistema de Persistência

### 🗄️ Estrutura do Banco de Dados

```mermaid
graph TB
    subgraph "MongoDB Collections"
        subgraph "bot_data"
            RAW[raw_candles_SYMBOL_TIMEFRAME]
            HIST[historical_data_SYMBOL_TIMEFRAME]
            AI_DATA[ai_data]
            AI_MODEL[ai_model]
            AI_STATS[ai_stats]
            STATUS[update_status]
        end
    end
    
    subgraph "JSON Fallback"
        J_RAW[raw_candles/*.json]
        J_HIST[historical_data/*.json]
        J_AI[ai_data/*.json]
    end
```

### 🔄 Priorização de Dados

1. **MongoDB** (Prioritário)
2. **JSON** (Fallback apenas se `FORCE_MONGO_ONLY = false`)

### 📁 Estrutura de Arquivos

```
binance-bot/
├── 📊 ai_data/
│   ├── ai_data.json
│   ├── ai_model.json
│   └── ai_stats.json
├── 📈 historical_data/
│   ├── historical_data_BTCUSDT_1m.json
│   ├── historical_data_BTCUSDT_5m.json
│   └── ...
├── 🕯️ raw_candles/
│   ├── raw_candles_BTCUSDT_1m.json
│   ├── raw_candles_BTCUSDT_5m.json
│   └── ...
├── ⚡ realtime_data/
│   ├── realtime_BTCUSDT_1m.json
│   └── ...
├── 🔧 index.js
├── 🤖 aiModule.js
├── 🌐 websocketService.js
├── 📡 dataHttp.js
├── 💾 database.js
├── ⚙️ config.json
└── 📦 package.json
```

---

## ⚙️ Configuração

### 📋 config.json

```json
{
  "symbolsToWatch": [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
    "XRPUSDT", "DOGEUSDT", "ADAUSDT", "DOTUSDT",
    "LTCUSDT", "BCHUSDT", "LINKUSDT", "ETCUSDT",
    "TRXUSDT", "MATICUSDT", "NEARUSDT", "APTUSDT"
  ],
  "timeframesToWatch": ["1m", "5m", "15m", "1h"],
  "quoteAsset": "USDT",
  "leverage": 2,
  "marginPercentPerTrade": 70,
  "takerFeePercent": 0.04,
  "strategies": {
    "trendFollowing": { /* configuração */ },
    "meanReversion": { /* configuração */ },
    "breakout": { /* configuração */ }
  },
  "aiModule": {
    "enabled": true,
    "trainingIntervalMs": 3600000
  }
}
```

### 🔑 Variáveis de Ambiente

```bash
# MongoDB (opcional - configurado no database.js)
MONGO_URL=mongodb://user:pass@host:port
DB_NAME=binance_bot

# Binance API (configurado no index.js)
BINANCE_API_KEY=sua_api_key
BINANCE_API_SECRET=sua_api_secret
```

---

## 🔧 Instalação

### 📋 Pré-requisitos

- **Node.js** 18+ 
- **MongoDB** 6.0+ (opcional)
- **Conta Binance** com API habilitada

### 🚀 Instalação Rápida

```bash
# 1. Clone o repositório
git clone https://github.com/seu-usuario/binance-bot.git
cd binance-bot

# 2. Instale as dependências
npm install

# 3. Configure as credenciais
# Edite index.js e adicione suas API keys da Binance

# 4. Configure o MongoDB (opcional)
# Edite database.js com suas credenciais

# 5. Execute o bot
npm start
```

### 🔧 Instalação Detalhada

```bash
# 1. Verificar Node.js
node --version  # Deve ser 18+

# 2. Instalar dependências
npm install

# 3. Configurar MongoDB (opcional)
# - Instale MongoDB
# - Configure a conexão em database.js
# - Ou deixe FORCE_MONGO_ONLY = false para usar apenas JSON

# 4. Configurar Binance API
# - Acesse sua conta Binance
# - Vá em API Management
# - Crie uma nova API key
# - Adicione as credenciais em index.js

# 5. Testar conexão
npm start
```

---

## 📈 Uso

### 🚀 Iniciando o Bot

```bash
# Modo produção
npm start

# Modo desenvolvimento (com auto-restart)
npm run dev
```

### 📊 Logs de Inicialização

```
================== Bot MTA v5 - [BTCUSDT, ETHUSDT, ...] ==================

🔌 Inicializando conexão com MongoDB...
✅ Conectado ao MongoDB
🚫 [FORCE_MONGO_ONLY] Modo exclusivo MongoDB ativado - JSON será ignorado

📊 [MongoDB] Verificando dados existentes no MongoDB...
📊 [MongoDB] 1130 velas brutas encontradas para BTCUSDT - 1m
⚠️ [MongoDB] Símbolo ETHUSDT não possui dados no MongoDB

[ATUALIZAÇÃO] Símbolos ausentes detectados. Será feita busca para: ETHUSDT, SOLUSDT
[ATUALIZAÇÃO] Buscando dados para ETHUSDT - 1m...
📊 [MongoDB] Salvos 1130 dados brutos para ETHUSDT - 1m

🤖 Módulo de IA: Dados de treinamento carregados do MongoDB.
🤖 Módulo de IA: Total de 4520 pontos de dados carregados do MongoDB.

[WebSocketService] Iniciando monitoramento de dados em tempo real...
  [BTCUSDT] [1m] já está PRÉ-AQUECIDO com 1130 velas.
  [ETHUSDT] [1m] precisa ser "aquecido" via WebSocket.

O bot está operando. Pressione CTRL + C para parar.
```

### 🎯 Modos de Operação

#### 1. **FULL_TRADING** (Negociação Completa)
- Abre novas posições
- Gerencia posições existentes
- Executa todas as estratégias

#### 2. **MANAGEMENT_ONLY** (Apenas Gerenciamento)
- Não abre novas posições
- Gerencia posições existentes
- Útil quando saldo é baixo

### 📊 Monitoramento em Tempo Real

```
[DECISÃO] [BTCUSDT][1m] Indicadores:
  Preço atual: 108796.6
  RSI: 21.38 | EMA: 108999.89 | BB: [108846.20, 108999.89]
  Volume: 47.417 | SMA Volume: 96.328

[IA] Previsão: LONG (confiança: 78.45%)
[IA] Features analisadas: [0.23, 0.45, 0.67, ...]

[DECISÃO] SINAL DE TENDÊNCIA + CONFIRMAÇÃO IA: LONG
[MOTIVO] Sinal aceito: Estratégia tradicional + confirmação IA.

[ORDEM] Parâmetros calculados:
  Saldo disponível: 11.46
  Margem por trade: 8.02
  Alavancagem: 2
  Tamanho posição (USD): 16.04
  Quantidade: 0.000147
```

---

## 🔍 Monitoramento

### 📊 Métricas Importantes

| Métrica | Descrição | Monitoramento |
|---------|-----------|---------------|
| **Posições Abertas** | Número de trades ativos | Logs em tempo real |
| **Saldo USDT** | Capital disponível | Verificação periódica |
| **Performance IA** | Taxa de acerto | Logs de treinamento |
| **Latência WebSocket** | Tempo de resposta | Logs de conexão |
| **Dados Históricos** | Quantidade de velas | Logs de carregamento |

### 🚨 Alertas e Notificações

O bot gera logs coloridos para diferentes tipos de eventos:

- 🟢 **Verde**: Operações bem-sucedidas
- 🟡 **Amarelo**: Avisos e informações
- 🔴 **Vermelho**: Erros críticos
- 🔵 **Azul**: Informações de sistema
- 🟣 **Magenta**: Decisões da IA

### 📈 Logs de Performance

```
🤖 Módulo de IA: Treinamento iniciado com 4520 pontos de dados
🤖 Módulo de IA: Época 1/10 - Loss: 0.234
🤖 Módulo de IA: Época 10/10 - Loss: 0.089
🤖 Módulo de IA: Treinamento concluído. IA pronta para trading.
```

---

## ⚠️ Avisos Importantes

### 🛡️ Gestão de Risco

1. **💰 Capital**: Nunca use mais de 5-10% do seu capital por trade
2. **🔒 Stop Loss**: Sempre configure stop loss automático
3. **📊 Diversificação**: Não concentre em um único ativo
4. **⏰ Monitoramento**: Monitore o bot regularmente
5. **🧪 Teste**: Teste em conta demo primeiro

### ⚠️ Limitações

- **📊 Volatilidade**: Mercados muito voláteis podem gerar falsos sinais
- **🔌 Conectividade**: Depende de conexão estável com a Binance
- **🤖 IA**: Modelo simplificado, não substitui análise humana
- **💰 Custos**: Taxas de trading podem impactar lucratividade

### 🚨 Riscos

- **Perda de Capital**: Trading envolve risco de perda
- **Falhas Técnicas**: Problemas de conectividade ou API
- **Mudanças de Mercado**: Estratégias podem se tornar ineficazes
- **Regulamentações**: Mudanças nas regras da Binance

---

## 📝 Logs e Debugging

### 🔍 Tipos de Logs

#### 1. **Logs de Sistema**
```
🔌 Inicializando conexão com MongoDB...
✅ Conectado ao MongoDB
📊 [MongoDB] Verificando dados existentes...
```

#### 2. **Logs de Decisão**
```
[DECISÃO] [BTCUSDT][1m] Indicadores:
  Preço atual: 108796.6
  RSI: 21.38 | EMA: 108999.89
[IA] Previsão: LONG (confiança: 78.45%)
```

#### 3. **Logs de Execução**
```
[ORDEM] Parâmetros calculados:
  Saldo disponível: 11.46
  Margem por trade: 8.02
  Quantidade: 0.000147
```

#### 4. **Logs de Erro**
```
❌ Erro ao conectar ao MongoDB: connection timeout
⚠️ [DataHttp] ERRO ao buscar dados para ETHUSDT - 1m
```

### 🐛 Debugging

#### Problemas Comuns

1. **❌ Falha de Conexão MongoDB**
   ```bash
   # Verificar se MongoDB está rodando
   mongosh --host 168.231.95.211 --port 27017
   ```

2. **❌ Erro de API Binance**
   ```bash
   # Verificar credenciais em index.js
   # Verificar permissões da API key
   ```

3. **❌ Dados Históricos Ausentes**
   ```bash
   # O bot detecta automaticamente e busca dados
   # Verificar logs de [ATUALIZAÇÃO]
   ```

4. **❌ IA Não Treinada**
   ```bash
   # Aguardar coleta de dados suficientes
   # Verificar logs de 🤖 Módulo de IA
   ```

---

## 🛠️ Desenvolvimento

### 📁 Estrutura do Código

```
src/
├── 🎯 index.js              # Bot principal
├── 🤖 aiModule.js           # Módulo de IA
├── 🌐 websocketService.js   # WebSockets
├── 📡 dataHttp.js           # Dados históricos
├── 💾 database.js           # Persistência
└── ⚙️ config.json           # Configuração
```

### 🔧 Adicionando Novas Estratégias

1. **Criar função de verificação**:
```javascript
function checkNovaEstrategia(symbol, config) {
    // Lógica da estratégia
    return { side: 'LONG', strategy: 'NovaEstrategia', config };
}
```

2. **Adicionar ao runMasterStrategy**:
```javascript
if (!signal && strategies.novaEstrategia.enabled) {
    const signal = checkNovaEstrategia(symbol, strategies.novaEstrategia);
    // Lógica de decisão
}
```

3. **Configurar em config.json**:
```json
{
  "strategies": {
    "novaEstrategia": {
      "enabled": true,
      "parametro1": 10,
      "parametro2": 20
    }
  }
}
```

### 🤖 Melhorando a IA

1. **Adicionar novas features**:
```javascript
// Em aiModule.js
aiModel.weights.novaFeature = 0.0;
```

2. **Processar dados**:
```javascript
// Em getFeatureVector()
features.push(normalize(dataPoint.novaFeature, stats.minNovaFeature, stats.maxNovaFeature));
```

3. **Coletar dados**:
```javascript
// Em collectData()
dataPoint.novaFeature = calcularNovaFeature();
```

### 🧪 Testes

```bash
# Teste de conectividade
node -e "const Binance = require('binance-api-node'); console.log('Binance API OK')"

# Teste de MongoDB
node -e "const { MongoClient } = require('mongodb'); console.log('MongoDB OK')"

# Teste de indicadores
node -e "const { RSI } = require('technicalindicators'); console.log('Indicators OK')"
```

---

## 📄 Licença

Este projeto está licenciado sob a **MIT License** - veja o arquivo [LICENSE](LICENSE) para detalhes.

---

## 🤝 Contribuição

1. **Fork** o projeto
2. **Crie** uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. **Commit** suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. **Push** para a branch (`git push origin feature/AmazingFeature`)
5. **Abra** um Pull Request

---

## 📞 Suporte

- **📧 Email**: seu-email@exemplo.com
- **🐛 Issues**: [GitHub Issues](https://github.com/seu-usuario/binance-bot/issues)
- **📖 Wiki**: [Documentação Completa](https://github.com/seu-usuario/binance-bot/wiki)

---

## 🙏 Agradecimentos

- **Binance** pela API robusta
- **Technical Indicators** pela biblioteca de indicadores
- **MongoDB** pelo sistema de persistência
- **Node.js** pela plataforma de execução

---

**⚠️ Disclaimer**: Este software é fornecido "como está" sem garantias. Trading envolve risco de perda de capital. Use por sua conta e risco. 