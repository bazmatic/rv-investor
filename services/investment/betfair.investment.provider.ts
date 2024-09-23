import {
    IInvestmentProvider,
    INVERSIFY_TOKENS,
    Investment,
    InvestmentStatus,
    PollFlag,
    Session,
    SessionStatus,
    StrategyReport
} from "@/types";

//import file system functions
import fs from "fs";

import { CollectionName, DBService } from "../db.service";
import {
    authenticate,
    listClearedOrders,
    listCurrentOrders,
    listMarketBook,
    listMarketCatalogue,
    placeOrders,
} from "betfair-api-ts";
import {

    ClearedOrderSummaryReport,
    MarketBook,
    MarketCatalogue,
    PlaceExecutionReport,
    PlaceInstruction,
    Runner,
    RunnerCatalog
} from "betfair-api-ts/lib/types/bettingAPI/betting";
// import { BetfairHistoricService } from "../betfair/betfair.historic.service";
import { SessionService } from "../session.service";
import { inject, injectable, LazyServiceIdentifier } from "inversify";

type Wager = {
    raceId: string;
    selections: number[];
    stake: number;
    isBack: boolean;
};

enum StrategyType {
    BackFav = "BackFav",
    LayFav = "LayFav",
}

// Extend Investment to BetfairInvestment so we can type investmentData
type BetfairInvestment = Investment & {
    _result?: any; // For testing
    strategies?: {
        chosen: boolean;
        investmentData: Wager;
        result?: number;
    }[];
};

const STRATEGIES = [StrategyType.BackFav, StrategyType.LayFav];

@injectable()
export class BetfairInvestmentProvider implements IInvestmentProvider {
    private timer: NodeJS.Timeout | null = null;
    constructor(
        // @inject(new LazyServiceIdentifier(() => INVERSIFY_TOKENS.Session))
        // private sessionService: SessionService,

        //callback: (error: any, authenticated: boolean) => void
        @inject(INVERSIFY_TOKENS.Database)
        private db: DBService,
    ) {
        const certificatePath = process.env.BETFAIR_CERT_PATH;
        const keyPath = process.env.BETFAIR_KEY_PATH;

        if (!certificatePath || !keyPath) {
            throw new Error(
                "BETFAIR_CERT_PATH or BETFAIR_KEY_PATH is not set in environment variables"
            );
        }

        const certificate = fs.readFileSync(certificatePath).toString();
        const certificateKey = fs.readFileSync(keyPath).toString();

        authenticate({
            username: process.env.BETFAIR_USERNAME ?? "",
            password: process.env.BETFAIR_PASSWORD ?? "",
            appKey: process.env.BETFAIR_APP_KEY ?? "",
            certificate,
            certificateKey
        })
            .then(client => {
                this.authenticated = true;
                if (this.timer) return;

                this.poll().then(() => {
                    console.log("Polling investments...");
                });
                //callback(null, true);
            })
            .catch(error => {
                console.error("Failed to authenticate with Betfair:", error);
                //callback(error, false);
            });
    }

    private authenticated: boolean = false;

    private async getNextRace(): Promise<MarketCatalogue> {
        const HORSE_RACING = "7";
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const marketCatalogues: MarketCatalogue[] = await listMarketCatalogue({
            filter: {
                eventTypeIds: [HORSE_RACING],
                bspOnly: true,
                marketStartTime: {
                    from: now.toISOString(),
                    to: tomorrow.toISOString()
                },
                marketTypeCodes: ["WIN"]
            },
            maxResults: 1,
            sort: "FIRST_TO_START",
            marketProjection: [
                "EVENT",
                "MARKET_START_TIME",
                "RUNNER_DESCRIPTION",
                "RUNNER_METADATA"
            ]
        });

        if (marketCatalogues.length === 0) {
            throw new Error("No matching events");
        }
        return marketCatalogues[0];
    }

    private async getOptions(
        marketId: string
    ): Promise<{ lay: Runner[]; back: Runner[]; market: MarketBook }> {
        const marketBooks: MarketBook[] = await listMarketBook({
            marketIds: [marketId],
            priceProjection: {
                priceData: ["EX_BEST_OFFERS", "SP_AVAILABLE", "SP_TRADED"],
                exBestOffersOverrides: {
                    bestPricesDepth: 1,
                    rollupModel: "STAKE",
                    rollupLimit: 0
                },
                virtualise: true
            }
        });

        if (marketBooks.length === 0) {
            throw new Error("No market book data available");
        }

        const marketBook = marketBooks[0];
        if (!marketBook.runners) {
            throw new Error("No runners in market book data");
        }
        const fav = getFavouriteBack(marketBook.runners);
        return {
            market: marketBook,
            lay: [fav],
            back: [fav]
        };
    }

    public async invest(sessionId: string): Promise<void> {
        const session = await this.db.getItem<Session>(CollectionName.Sessions, sessionId);
        if (!session) {
            throw new Error("Session not found");
        }
        const strategyIdx = session.chosenImageIdx;

        if (strategyIdx === undefined || strategyIdx === null || strategyIdx < 0 || strategyIdx >= STRATEGIES.length) {
            throw new Error(`Invalid strategy index: ${strategyIdx}`);
        }

        console.log("Investing in strategy:", STRATEGIES[strategyIdx]);


        session.data.strategyIdx = strategyIdx;
        session.status = SessionStatus.Investing;
        await this.db.saveItem<Session>(CollectionName.Sessions, session);
    }

    private  async isPolling(): Promise<boolean> {           
        const pollFlag = await this.db.getItem<PollFlag>(CollectionName.Flags, BetfairInvestmentProvider.name);
        return !!pollFlag?.running
    }

    private async poll() {
        // const pollFlag = await this.db.getItem<PollFlag>(CollectionName.Flags, BetfairInvestmentProvider.name);
        // if (pollFlag) {
        //     console.log("Already polling");
        //     return;
        // }
        console.log("Polling investments...");

        this.timer = setInterval(async () => {
            //const pollFlag = await this.db.getItem<PollFlag>(CollectionName.Flags, BetfairInvestmentProvider.name);
            if (await this.isPolling()) {
                console.log("Already running");
                return;
            }

            await this.db.saveItem<PollFlag>(CollectionName.Flags, { id: BetfairInvestmentProvider.name, running: true });
            console.log("Processing 'investing' investments...");
            await this.handleInvestingSessions(); 
            console.log("Processing 'invested' investments...");
            await this.handleInvestedSessions();    
            console.log("Processed investments");   
            
            await this.db.saveItem<PollFlag>(CollectionName.Flags, { id: BetfairInvestmentProvider.name, running: false });

        }, 60000);
    }

    private async handleInvestingSessions(): Promise<void> {
        // Look for sessions with a strategy not yet resolved
        const sessions = await this.db.query<Session>(CollectionName.Sessions, {
            status: SessionStatus.Investing
        });
        if (sessions.length === 0) {
            return;
        }
        for (const session of sessions) {
            await this.executeInvestment(session);
        }
    }

    private async handleInvestedSessions(): Promise<void> {
        // Look for sessions with a strategy not yet resolved
        const sessions = await this.db.query<Session>(CollectionName.Sessions, {
            status: SessionStatus.Invested
        });
        if (sessions.length === 0) {
            return;
        }
        for (const session of sessions) {
            await this.resolveInvestment(session.id);
        }
    }

    public async executeInvestment(session: Session): Promise<void> {
        const strategyIdx = session.data.strategyIdx;
        const market = await this.getNextRace();
        const options = await this.getOptions(market.marketId);
        if (strategyIdx < 0 || strategyIdx >= STRATEGIES.length) {
            throw new Error("Invalid strategy");
        }
        const strategy = STRATEGIES[strategyIdx];
        const isLay = strategy === StrategyType.LayFav;
        const placeExecutionReport: PlaceExecutionReport = await makeBet(options.market, options.back[0], 1, isLay);
        // Check if all bets were placed successfully
        const allBetsPlaced = placeExecutionReport.instructionReports?.every(
            report => report.orderStatus !== 'EXPIRED' && report.status === 'SUCCESS'
        );
        
        if (!allBetsPlaced) {
            console.warn("Failed to place bet");
            return;
        }
        session.status = SessionStatus.Invested;
        session.data.customerRef = placeExecutionReport.customerRef;
        session.data.marketId = market.marketId;
        session.data.executionReport = placeExecutionReport;
        await this.db.saveItem<Session>(CollectionName.Sessions, session);
    }


    public async resolveInvestment(sessionId: string): Promise<void> {
        const session = await this.db.getItem<Session>(CollectionName.Sessions, sessionId);
        if (!session) {
            throw new Error("Session not found");
        }
        const investment = session.data as PlaceExecutionReport;
        if (!investment?.customerRef) {
            throw new Error("No customer reference in investment data");
        }
        if (session.chosenImageIdx === undefined || session.chosenImageIdx === null) {
            throw new Error("No chosen image index in session");
        }

        const clearedOrderSummaryReport: ClearedOrderSummaryReport = await
            listClearedOrders({
                betStatus: "SETTLED",
                //marketIds: [investment.marketId ?? "none"]
                //betIds: [investment.customerRef],
                //customerOrderRefs: [investment.customerRef] 
        });

        if (!clearedOrderSummaryReport.clearedOrders) {
            throw new Error("No cleared orders found");
        }

        // Find the investment in the cleared orders
        const clearedOrder = clearedOrderSummaryReport.clearedOrders.find(
            order => {
                return order.marketId === investment.marketId;
            }             
        );
        if (!clearedOrder) {
            throw new Error("No cleared order found");
        }
        console.log("Cleared order:", clearedOrder);

        // If we won, then update the session 'targetImageIdx' to the chosen image index
        // If we lost, then update the session 'targetImageIdx' to the other image index
        const won = clearedOrder.betOutcome === "WIN";
        session.targetImageIdx = won ? session.chosenImageIdx : (session.chosenImageIdx + 1) % 2;
        session.status = SessionStatus.InvestmentResolved;
        await this.db.saveItem<Session>(CollectionName.Sessions, session);
    }
}

function getFavouriteBack(runners: Runner[]): Runner {
    // Sort by price
    runners.sort((a, b) => {
        return (
            a.ex?.availableToBack?.[0]?.price! -
            b.ex?.availableToBack?.[0]?.price!
        );
    });
    // Return the first runner
    return runners[0];
}

async function makeBet(market: MarketBook, runner: Runner, amountPerRunner: number, lay: boolean): Promise<PlaceExecutionReport> {
    // Create an array of PlaceInstruction objects for each runner
    const instructions: PlaceInstruction = {
        orderType: 'LIMIT',
        selectionId: runner.selectionId,
        side: lay ? 'LAY' : 'BACK',
        limitOrder: {
            size: amountPerRunner,
            price: lay ? runner.ex?.availableToLay?.[0]?.price! : runner.ex?.availableToBack?.[0]?.price!,
            persistenceType: 'LAPSE',
            timeInForce: 'FILL_OR_KILL'
        }
    };

    // Place the orders
    try {
        const placeExecutionReport: PlaceExecutionReport = await placeOrders({
            marketId: market.marketId,
            instructions: [instructions],
            marketVersion: market,
            
            customerRef: `bet_${Date.now()}` // Unique reference for this set of bets
        });

        // Log the result
        console.log('Bets placed:', placeExecutionReport);

        return placeExecutionReport;
    } catch (error) {
        console.error('Error placing bets:', error);
        throw error;
    }
}