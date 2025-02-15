// main.ts
import { load } from "https://deno.land/std@0.219.0/dotenv/mod.ts";
import { GoogleGenerativeAI, SchemaType } from "https://esm.sh/@google/generative-ai";

// Basic type definitions
interface Token {
  description: string;
  logo: string;
  name: string;
  symbol: string;
}

interface PredictionResponse {
  direction: "up" | "down";
  confidence: number;
  current_price: number;
  predicted_price: number;
  timestamp: string;
  data_points: number;
  price_change_pct: number;
}

interface Game {
  id: string;
  state: string;
  participants: Array<{
    tokens: number;
    username: string;
    coins: Record<string, number>;
  }>;
  rankings?: Array<{
    tokens: number;
    username: string;
    rank: number;
    points: number;
  }>;
  prices?: Record<string, number[]>;
}

class FunstashAgent {
  private ws: WebSocket;
  private model: any;
  private apiKey: string;
  private heartbeatInterval?: number;
  private currentPredictions: Record<string, number> = {};
  private gameHistory: Array<{
    symbol: string;
    prediction: number;
    success: boolean;
    points: number;
  }> = [];
  private geminiApiKey: string;
  private genAI: any;

  constructor(apiKey: string, geminiApiKey: string) {
    this.apiKey = apiKey;
    this.geminiApiKey = geminiApiKey;
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.ws = new WebSocket("wss://funstash.ngrok.dev/ws/websocket");
    this.setupWebSocket();
  }

  private setupWebSocket() {
    this.ws.onopen = () => {
      console.log("Connected to Funstash");
      this.joinLobby();
      this.startHeartbeat();
    };

    this.ws.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      
      if (message.event === "game_update") {
        const game = message.payload as Game;
        
        switch (game.state) {
          case "waiting_for_players":
            console.log("New game:", game);
			
			const inGameAlready = game.participants.some(participant => 
			  participant.username.toLowerCase() === "pinky 🧠".toLowerCase()
			);

			console.log("inGame", inGameAlready)	

			if (!inGameAlready) {
				console.log("joining game")
            	await this.handleNewGame(game);
			}	
            break;
          case "ended":
            this.handleGameEnd(game);
            break;
        }
      }
    };

    this.ws.onclose = () => {
      console.log("Disconnected from Funstash");
      this.stopHeartbeat();
    };
  }

  private async getPrediction(symbol: string): Promise<PredictionResponse> {
    try {
      const response = await fetch(`http://localhost:8000/api/token/${symbol.toLowerCase()}`);
      if (!response.ok) {
        throw new Error(`Failed to get prediction for ${symbol}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Error fetching prediction for ${symbol}:`, error);
      throw error;
    }
  }

  private async makePredictions(tokens: Token[]): Promise<Record<string, number>> {
    // Get predictions for all tokens
    const tokenPredictions = await Promise.all(
      tokens.map(async (token) => {
        try {
          const prediction = await this.getPrediction(token.symbol);
          return {
            symbol: token.symbol,
            direction: prediction.direction === "up" ? 1 : -1,
            confidence: prediction.confidence
          };
        } catch (error) {
          console.error(`Failed to get prediction for ${token.symbol}:`, error);
          return null;
        }
      })
    );

    // Filter out failed predictions and sort by confidence
    const validPredictions = tokenPredictions
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => b.confidence - a.confidence);

    let prompt = "You are an agent playing a meme coin price prediction game. You have to select 3 tokens and predict weather the price will go up or down for the next 60 sconds. Below are the results of a time series forecast for each token. If your previous game ranking is 1 and you won, you might consider the same picks. When considering the previous game outcome, the Points are important (the higher positive number the better)\n\n";

    for (const pred of validPredictions) {
      prompt += `symbol: ${pred.symbol}, direction: ${pred.direction} (1 means up, -1 means down), confidence: ${pred.confidence}\n`;
    }

    // take game history and add it to the predictions
	if (this.gameHistory.length > 0) {
		prompt += "\nPrevious game outcome:\n";
    	const gameHistory = this.gameHistory.slice(Math.max(this.gameHistory.length - 3, 0));;
		const ranking = gameHistory[0].ranking;
		prompt += `Ranking: ${ranking.rank}\n`;	
    	for (const game of gameHistory) {
    	  prompt += `${game.symbol} (${game.prediction}) Success ${game.success} Points ${game.points}\n`;
    	}
		
	}

	const schema = {
	  description: "List of token entries for the game",
	  type: SchemaType.ARRAY,
	  items: {
	    type: SchemaType.OBJECT,
	    properties: {
		  token: {
			type: SchemaType.STRING,
			description: "Token symbol",
            nullable: false	
	      },
	      prediction: {
	        type: SchemaType.NUMBER,
	        description: "Prediction for the token, 1 for up -1 for down",
	        nullable: false,
	      },
	    },
	    required: ["token", "prediction"],
	  },
	};

	console.log("prompt", prompt)

	const model = this.genAI.getGenerativeModel({
	  model: "gemini-1.5-pro",
	  generationConfig: {
	    responseMimeType: "application/json",
	    responseSchema: schema,
	  },
	});

    const { response: predictions } = await model.generateContent(prompt);
	const predictionsArray = JSON.parse(predictions.text());

	const result = predictionsArray.reduce((acc, {prediction, token}) => {
	  acc[token] = prediction;
	  return acc;
	}, {});

    return result;	
  }

  private async handleNewGame(game: Game) {
    try {
      const tokens = await this.getTokens();
      const predictions = await this.makePredictions(tokens);
      console.log("API-based predictions:", predictions);
      
      await this.joinGame(game.id, predictions);
      this.currentPredictions = predictions;
      
      console.log("Joined game", game.id, "with predictions:", predictions);
    } catch (error) {
      console.error("Error handling new game:", error);
    }
  }

  private handleGameEnd(game: Game) {
    if (!game.rankings || !game.prices) return;

    try {
        for (const [symbol, prediction] of Object.entries(this.currentPredictions)) {
          const prices = game.prices[symbol];
          if (!prices || prices.length < 2) continue;

		  const ranking = game.rankings.find((r) => r.username === "Pinky 🧠");

          const startPrice = prices[0];
          const endPrice = prices[prices.length - 1];
          const actualMove = endPrice > startPrice ? 1 : -1;
          const success = prediction === actualMove;
          const points = game.rankings[0].points;

          this.gameHistory.push({
			ranking,
            symbol,
            prediction,
            success,
            points
          });

          console.log(
            `Token ${symbol}: ${success ? "CORRECT" : "WRONG"} prediction`,
            `(predicted ${prediction > 0 ? "UP" : "DOWN"}, went ${actualMove > 0 ? "UP" : "DOWN"})`
          );
        }
    } catch (error) {
      console.error("Error handling game end:", error);
    }

    console.log("Game history size:", this.gameHistory.length);
  }

  private async getTokens(): Promise<Token[]> {
    const response = await fetch("https://funstash.ngrok.dev/api/tokens", {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error("Failed to fetch tokens");
    }

    const data = await response.json();
    return data.tokens;
  }

  private async joinGame(gameId: string, predictions: Record<string, number>) {
    const response = await fetch(
      `https://funstash.ngrok.dev/api/games/${gameId}/join`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          game: {
            coins: predictions,
            tokens: 1000  // Default bet amount
          }
        })
      }
    );

    return response.json();
  }

  private joinLobby() {
    const message = {
      topic: "games:lobby",
      event: "phx_join",
      ref: null,
      payload: { api_key: this.apiKey }
    };
    this.ws.send(JSON.stringify(message));
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const message = {
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: Date.now()
      };
      this.ws.send(JSON.stringify(message));
    }, 30000);  // 30 seconds
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }
}

// Start the agent
async function main() {
  const env = await load();
  const apiKey = "" // Funstash API Key
  const geminiApiKey = "" // Gemini API Key
  new FunstashAgent(apiKey, geminiApiKey);
  await new Promise(() => {});
}

if (import.meta.main) {
  main().catch(console.error);
}
