import type { Answer, Offer, SessionDescription } from "./session-room";

export { SessionRoom } from "./session-room";

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

function handleHealth(): Response {
	return Response.json({ status: "ok" });
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
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

async function handleJoinSession(sessionId: string, env: Env): Promise<Response> {
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

async function handleGetAnswer(request: Request, env: Env, sessionId: string): Promise<Response> {
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
}

async function handlePutAnswer(request: Request, env: Env, sessionId: string): Promise<Response> {
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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return handleHealth();
		}


		if (request.method === "POST" && url.pathname === "/sessions") {
			return handleCreateSession(request, env);
		}


		const joinMatch = url.pathname.match(
			/^\/join\/([0-9a-f-]{36})$/i
		);

		if (joinMatch && request.method === "POST") {
			return handleJoinSession(joinMatch[1], env);
		}

		const answerMatch = url.pathname.match(
			/^\/sessions\/([0-9a-f-]{36})\/answer$/i
		);

		if (answerMatch) {
			switch (request.method) {
				case "GET":
					return handleGetAnswer(request, env, answerMatch[1]);
				case "PUT":
					return handlePutAnswer(request, env, answerMatch[1]);

			}
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

