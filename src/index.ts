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

type SessionDescription = {
	type: "offer" | "answer";
	sdp: string;
};

type Offer = SessionDescription & {
	type: "offer";
};


type OfferResult =
	| { status: "ready"; sdp: string }
	| { status: "pending" }
	| { status: "unauthorized" };


type Answer = SessionDescription & {
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


export class SessionRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async create(
		expiresAt: number,
		hostToken: string,
		offer: Offer
	): Promise<void> {
		await this.ctx.storage.put({
			expiresAt,
			hostToken,
			offer,
		});
	}

	async getStatus(): Promise<SessionStatus> {
		const expiresAt =
			await this.ctx.storage.get<number>("expiresAt");

		// Does the session exist?
		if (expiresAt === undefined) {
			return "not_found";
		}

		// Has the invitation expired?
		if (Date.now() >= expiresAt) {
			return "not_found";
		}

		// Has a guest already joined?
		const guestToken =
			await this.ctx.storage.get<string>("guestToken");

		if (guestToken !== undefined) {
			return "full";
		}

		return "open";
	}

	async setOffer(
		token: string,
		sdp: string
	): Promise<boolean> {
		const hostToken =
			await this.ctx.storage.get<string>("hostToken");

		if (!hostToken || token !== hostToken) {
			return false;
		}

		await this.ctx.storage.put("offer", sdp);
		return true;
	}

	async getOffer(token: string): Promise<OfferResult> {
		const guestToken =
			await this.ctx.storage.get<string>("guestToken");

		if (!guestToken || token !== guestToken) {
			return { status: "unauthorized" };
		}

		const sdp =
			await this.ctx.storage.get<string>("offer");

		if (sdp === undefined) {
			return { status: "pending" };
		}

		return { status: "ready", sdp };
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


function isDescription(
	value: unknown,
	expectedType: "offer" | "answer"
): value is SessionDescription {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === expectedType &&
		"sdp" in value &&
		typeof value.sdp === "string" &&
		value.sdp.length > 0 &&
		value.sdp.length <= 64_000
	);
}


const INVITE_LIFETIME_MS = 5 * 60 * 1000; // 5 mins 

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Our existing health endpoint
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "ok" });
		}


		if (request.method === "POST" && url.pathname === "/sessions") {
			const body: unknown =
				await request.json().catch(() => null);

			if (
				typeof body !== "object" ||
				body === null ||
				!("offer" in body) ||
				!isDescription(body.offer, "offer")
			) {
				return Response.json(
					{ error: "Invalid Offer" },
					{ status: 400 }
				);
			}

			const offer: Offer = {
				type: "offer",
				sdp: body.offer.sdp,
			};

			const sessionId = crypto.randomUUID();
			const hostToken = crypto.randomUUID();
			const expiresAt = Date.now() + INVITE_LIFETIME_MS;

			const room = env.SESSION_ROOM.getByName(sessionId);

			await room.create(expiresAt, hostToken, offer);

			return Response.json(
				{
					sessionId,
					hostToken,
					expiresIn: 300,
					expiresAt: new Date(expiresAt).toISOString(),
				},
				{
					status: 201,
					headers: { "Cache-Control": "no-store" },
				}
			);
		}


		const joinMatch = url.pathname.match(
			/^\/join\/([0-9a-f-]{36})$/i
		);

		if (joinMatch && request.method === "POST") {
			const sessionId = joinMatch[1];
			const room = env.SESSION_ROOM.getByName(sessionId);

			const result = await room.join();

			switch (result.status) {
				case "not_found":
					return Response.json(result, { status: 404 });

				case "expired":
					return Response.json(result, { status: 410 });

				case "full":
					return Response.json(result, { status: 409 });

				case "joined":
					return Response.json(
						{
							...result,
							sessionId,
						},
						{
							headers: { "Cache-Control": "no-store" },
						}
					);
			}
		}

		const answerMatch = url.pathname.match(
			/^\/sessions\/([0-9a-f-]{36})\/answer$/i
		);

		if (answerMatch) {
			if (request.method !== "PUT" && request.method !== "GET") {
				return new Response("Method not allowed", {
					status: 405,
					headers: { Allow: "GET, PUT" },
				});
			}

			const sessionId = answerMatch[1];
			const room = env.SESSION_ROOM.getByName(sessionId);

			const token = request.headers
				.get("Authorization")
				?.match(/^Bearer ([^\s]+)$/i)?.[1];

			if (!token) {
				return Response.json(
					{ error: "Missing token" },
					{ status: 401 }
				);
			}

			if (request.method === "GET") {
				const result = await room.getAnswer(token);

				switch (result.status) {
					case "unauthorized":
						return Response.json(result, { status: 401 });

					case "pending":
					case "ready":
						return Response.json(result, {
							headers: { "Cache-Control": "no-store" },
						});
				}
			} else { // PUT 
				// Validate the request 
				const body: unknown =
					await request.json().catch(() => null);

				if (
					typeof body !== "object" ||
					body === null ||
					!("answer" in body) ||
					!isDescription(body.answer, "answer")
				) {
					return Response.json(
						{ error: "Invalid Answer" },
						{ status: 400 }
					);
				}

				const answer: Answer = {
					type: "answer",
					sdp: body.answer.sdp,
				};

				const result = await room.setAnswer(token, answer);

				switch (result) {
					case "saved":
						return Response.json({ status: "saved" });

					case "already_submitted":
						return Response.json(
							{ error: "Answer already submitted" },
							{ status: 409 }
						);

					case "unauthorized":
						return Response.json(
							{ error: "Unauthorized" },
							{ status: 401 }
						);
				}
			}

		}



		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;





