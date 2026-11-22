import { DurableObject } from "cloudflare:workers";

type SessionStatus =
	| "open"
	| "full"
	| "expired"
	| "not_found";

type JoinResult =
	| {
		status: "joined";
		guestToken: string;
		offer: Offer;
	}
	| {
		status: "full" | "expired" | "not_found"
	};

export type SessionDescription = {
	type: "offer" | "answer";
	sdp: string;
};

export type Offer = SessionDescription & {
	type: "offer";
};


type OfferResult =
	| { status: "ready"; sdp: string }
	| { status: "pending" }
	| { status: "unauthorized" };


export type Answer = SessionDescription & {
	type: "answer";
};

type SaveAnswerResult =
	| "saved"
	| "already_submitted"
	| "unauthorized";

type GetAnswerResult =
	| { status: "ready"; answer: Answer }
	| { status: "pending" }
	| { status: "unauthorized" };


const INITIAL_CLEANUP_DELAY_MS = 10 * 60 * 1000; // 10 mins
const JOINED_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 mins

export class SessionRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async create(
		expiresAt: number,
		hostToken: string,
		offer: Offer
	): Promise<void> {
		const cleanupAt = Date.now() + INITIAL_CLEANUP_DELAY_MS;

		await this.ctx.storage.transaction(async (txn) => {
			await txn.put({ expiresAt, hostToken, offer });
			await txn.setAlarm(cleanupAt);
		});
	}

	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async join(): Promise<JoinResult> {
		return this.ctx.storage.transaction(async (txn) => {
			const expiresAt = await txn.get<number>("expiresAt");

			if (expiresAt === undefined) {
				return { status: "not_found" } as const;
			}

			if (Date.now() >= expiresAt) {
				return { status: "expired" } as const;
			}

			const existingGuest =
				await txn.get<string>("guestToken");

			if (existingGuest !== undefined) {
				return { status: "full" } as const;
			}

			const offer = await txn.get<Offer>("offer");

			if (!offer) {
				throw new Error("Session has no offer");
			}

			const guestToken = crypto.randomUUID();

			await txn.put("guestToken", guestToken);
			await txn.setAlarm(Date.now() + JOINED_CLEANUP_DELAY_MS);

			return {
				status: "joined",
				guestToken,
				offer,
			} as const;
		});
	}


	async setAnswer(
		token: string,
		answer: Answer
	): Promise<SaveAnswerResult> {
		return this.ctx.storage.transaction(async (txn) => {
			const guestToken =
				await txn.get<string>("guestToken");

			if (!guestToken || token !== guestToken) {
				return "unauthorized";
			}

			const existingAnswer =
				await txn.get<Answer>("answer");

			if (existingAnswer !== undefined) {
				return "already_submitted";
			}

			await txn.put("answer", answer);

			return "saved";
		});
	}


	async getAnswer(
		token: string
	): Promise<GetAnswerResult> {
		const hostToken =
			await this.ctx.storage.get<string>("hostToken");

		if (!hostToken || token !== hostToken) {
			return { status: "unauthorized" };
		}

		// we don't check expiration here 

		const answer =
			await this.ctx.storage.get<Answer>("answer");

		if (answer === undefined) {
			return { status: "pending" };
		}

		return { status: "ready", answer };
	}
}
