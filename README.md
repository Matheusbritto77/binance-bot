# Bot de Trading para Binance Futures (Scalping Inteligente)

Este é um bot de trading automatizado para a Binance Futures, projetado para operar o par BTC/USDT (ou outro configurado) com uma estratégia de **Scalping Inteligente** baseada nos indicadores RSI e EMA. O bot utiliza WebSockets para obter dados de mercado em tempo real e foi construído com uma arquitetura modular para facilitar a manutenção e a escalabilidade.

---

## 🚦 Ambiente Atual

> **Atenção:** O bot está configurado para rodar na **Testnet** da Binance (`useTestnet: true`).
> 
> Para operar na rede real (Mainnet), altere a variável `useTestnet` para `false` no arquivo `config/binance.js`.

---

## 📁 Estrutura do Projeto

```
/
|-- config/
|   |-- binance.js         # Configuração central (API, ambiente, estratégia)
|
|-- src/
|   |-- services/
|   |   |-- binanceService.js  # Lógica para interagir com a API da Binance
|   |   |-- websocketService.js# Gerenciamento das conexões WebSocket
|   |   |-- taService.js       # Cálculo de indicadores técnicos (RSI, EMA)
|   |
|   |-- strategies/
|   |   |-- scalpingStrategy.js# Lógica principal da estratégia de trading
|   |
|   |-- utils/
|   |   |-- logger.js          # Funções de logging
|   |   |-- helpers.js         # Funções auxiliares
|
|-- index.js                 # Ponto de entrada da aplicação
|-- package.json
|-- README.md
```

---

## ⚙️ Instalação

1. **Clone o repositório:**
   ```bash
   git clone <URL_DO_REPOSITORIO>
   cd <NOME_DO_PROJETO>
   ```
2. **Instale as dependências:**
   ```bash
   npm install
   ```
3. **Configure as chaves de API:**
   - Crie um arquivo `.env` na raiz do projeto (recomendado):
     ```env
     API_KEY=SUA_CHAVE_DE_API
     API_SECRET=SUA_CHAVE_SECRETA
     ```
   - Ou edite diretamente em `config/binance.js` (não recomendado para produção).
4. **Ajuste os parâmetros de trading e estratégia em `config/binance.js` se desejar.**

---

## 🚀 Como Executar

```bash
node index.js
```
O console exibirá todos os logs de atividade do bot em tempo real.

---

## 🧠 Estratégia de Trading
- **Entrada LONG:**
  - RSI cruza acima de 30 (saindo da sobrevenda)
  - Preço acima da EMA 200
- **Entrada SHORT:**
  - RSI cruza abaixo de 70 (saindo da sobrecompra)
  - Preço abaixo da EMA 200
- **Saída:**
  - Take Profit e Stop Loss automáticos, conforme configurado

---

## 🛡️ Gerenciamento de Risco
- Alavancagem configurável
- Quantidade calculada automaticamente conforme o saldo e regras do par
- Logs detalhados de todas as operações

---

## 📢 Avisos Importantes
- **Nunca compartilhe suas chaves de API.**
- Use sempre a Testnet para testes antes de operar na Mainnet.
- Este projeto é para fins educacionais. Use por sua conta e risco.

---

## 📚 Referências
- [Binance Futures Testnet](https://testnet.binancefuture.com/)
- [Documentação oficial da Binance API](https://binance-docs.github.io/apidocs/futures/en/)
- [technicalindicators (NPM)](https://www.npmjs.com/package/technicalindicators)

---

## 👨‍💻 Autor
- Desenvolvido por Trading Bot Developer 