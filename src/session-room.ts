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
	| "offer_available"
	| "unauthorized";

type GetAnswerResult =
	| { status: "ready"; answer: Answer }
	| { status: "pending" }
	| { status: "unauthorized" };


const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const DESCRIPTION_LIFETIME_MS = 5 * 60 * 1000;

export class SessionRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async create(
		expiresAt: number,
		hostToken: string,
		offer: Offer
	): Promise<void> {
		const cleanupAt = Date.now() + SESSION_LIFETIME_MS;

		await this.ctx.storage.transaction(async (txn) => {
			await txn.put({ expiresAt, hostToken, offer });
			await txn.setAlarm(cleanupAt);
		});
	}

	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async setOffer(
		requestHosttoken: string,
		offer: Offer,
		expiresAt: number
	): Promise<"saved" | "unauthorized"> {
		return this.ctx.storage.transaction(async (txn) => {
			const hostToken = await txn.get<string>("hostToken");

			if (!hostToken || requestHosttoken !== hostToken) {
				return "unauthorized";
			}

			await txn.put({ offer, expiresAt });
			await txn.delete(["answer", "answerExpiresAt"]);
			await txn.setAlarm(Date.now() + SESSION_LIFETIME_MS);

			return "saved";
		});
	}

	async join(): Promise<JoinResult> {
		return this.ctx.storage.transaction(async (txn) => {
			const expiresAt = await txn.get<number>("expiresAt");

			if (expiresAt === undefined) {
				return { status: "not_found" } as const;
			}

			await txn.setAlarm(Date.now() + SESSION_LIFETIME_MS);

			if (Date.now() >= expiresAt) {
				return { status: "expired" } as const;
			}

			const offer = await txn.get<Offer>("offer");

			if (!offer) {
				return { status: "full" } as const;
			}

			const guestToken = crypto.randomUUID();

			await txn.put("guestToken", guestToken);
			await txn.delete("offer");

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

			await txn.setAlarm(Date.now() + SESSION_LIFETIME_MS);

			if (await txn.get<Offer>("offer") !== undefined) {
				return "offer_available";
			}

			const existingAnswer =
				await txn.get<Answer>("answer");

			if (existingAnswer !== undefined) {
				return "already_submitted";
			}

			await txn.put({ answer, answerExpiresAt: Date.now() + DESCRIPTION_LIFETIME_MS });

			return "saved";
		});
	}


	async getAnswer(
		token: string
	): Promise<GetAnswerResult> {
		return this.ctx.storage.transaction(async (txn) => {
			const hostToken = await txn.get<string>("hostToken");

			if (!hostToken || token !== hostToken) {
				return { status: "unauthorized" } as const;
			}

			await txn.setAlarm(Date.now() + SESSION_LIFETIME_MS);

			const answer = await txn.get<Answer>("answer");
			const expiresAt = await txn.get<number>("answerExpiresAt");

			if (answer === undefined || expiresAt === undefined || Date.now() >= expiresAt) {
				return { status: "pending" } as const;
			}

			return { status: "ready", answer } as const;
		});
	}
}
