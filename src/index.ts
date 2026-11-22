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
// Allow JSON escaping overhead for a 64,000-character SDP.
const MAX_JSON_BODY_BYTES = 512 * 1024;

async function readJsonBody(request: Request): Promise<unknown> {
	const tooLarge = () => Response.json(
		{ error: "Request body too large" },
		{ status: 413 }
	);

	if (Number(request.headers.get("Content-Length")) > MAX_JSON_BODY_BYTES) {
		return tooLarge();
	}

	if (!request.body) {
		return null;
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			size += value.byteLength;
			if (size > MAX_JSON_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				return tooLarge();
			}
			chunks.push(value);
		}
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function handleHealth(): Response {
	return Response.json({ status: "ok" });
}

async function handleCreateSession(request: Request, env: Env): Promise<Response> {
	const body = await readJsonBody(request);
	if (body instanceof Response) {
		return body;
	}

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
		{ status: 201 }
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
			return Response.json({ ...result, sessionId });
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
			return Response.json(result);
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
	const body = await readJsonBody(request);
	if (body instanceof Response) {
		return body;
	}

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

function handleOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
			"Access-Control-Max-Age": "86400",
		},
	});
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "OPTIONS") {
		return handleOptions();
	}

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
}

export default {
	async fetch(request: Request, env: Env & { CORS_ORIGIN?: string }): Promise<Response> {
		let response: Response;

		try {
			response = await route(request, env);
		} catch (error) {
			console.error("Request failed", error);
			response = Response.json({ error: "Internal server error" }, { status: 500 });
		}

		response.headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN ?? "*");
		response.headers.set("Cache-Control", "no-store");

		return response;
	},
} satisfies ExportedHandler<Env>;
