# Handshaker 

This "Handshaker" Cloudflare worker server helps devices setup a WebRTC connection. 

## API 

All request and response bodies below are JSON. Send JSON request bodies with `Content-Type: application/json`. `:id` is the session ID returned when creating a session.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | Anyone | Check service health |
| POST | `/sessions` | Host | Create a session with an offer |
| POST | `/sessions/:id` | Host | Set a new offer using the host token |
| POST | `/join/:id` | Guest | Claim a session and receive its offer |
| PUT | `/sessions/:id/answer` | Guest | Submit an answer using the guest token |
| GET | `/sessions/:id/answer` | Host | Retrieve the answer using the host token |

### Lifetimes and reuse

Sessions remain for 30 days, extended by another 30 days whenever they are used. Requests with invalid tokens do not extend the session.

Offers expire 5 minutes after being set. Answers expire 5 minutes after being submitted. These expirations do not delete the session: the host can reuse the same session ID and host token to set a new offer.


### GET /health

No request body or authorization required.

**200 OK**

```json
{
  "status": "ok"
}
```

### POST /sessions

No authorization required.

**Request body**

```json
{
  "offer": {
    "type": "offer",
    "sdp": "v=0\r\n..."
  }
}
```

`offer.type` must be `"offer"`. `offer.sdp` must be a non-empty string of at most 64,000 characters.

**201 Created**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "hostToken": "550e8400-e29b-41d4-a716-446655440001",
  "expiresIn": 300,
  "expiresAt": "2026-01-01T12:05:00.000Z"
}
```

`expiresIn` is the offer lifetime in seconds (5 minutes), not the session lifetime. `expiresAt` is the offer's expiration time in ISO 8601 format. Keep `hostToken` for retrieving the answer and setting new offers.

### POST /sessions/:id

Requires `Authorization: Bearer <hostToken>`. Uses the same request body and offer validation as `POST /sessions`.

Replaces the current offer, gives it a new 5-minute lifetime, and clears any previous answer. The session ID and host token remain unchanged.

**200 OK**

```json
{
  "status": "saved"
}
```

### POST /join/:id

No request body required. The first claim requires no authorization and issues a guest token. All subsequent join requests require `Authorization: Bearer <guestToken>`. The guest token remains unchanged across reconnections, including when the host sets a new offer. Only one guest can claim each offer, and claiming removes the offer.

Returns **401** if a previously claimed session's guest token is missing or invalid, **404** if the session does not exist, **410** if the offer has expired, or **409** if the offer has already been claimed. Unauthorized requests do not extend the session lifetime.

**200 OK**

```json
{
  "status": "joined",
  "guestToken": "550e8400-e29b-41d4-a716-446655440002",
  "offer": {
    "type": "offer",
    "sdp": "v=0\r\n..."
  },
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Keep `guestToken` securely for submitting answers and reconnecting to this session. If the guest loses its token, create a new session to pair again.

### PUT /sessions/:id/answer

Requires `Authorization: Bearer <guestToken>`.

**Request body**

```json
{
  "answer": {
    "type": "answer",
    "sdp": "v=0\r\n..."
  }
}
```

`answer.type` must be `"answer"`. `answer.sdp` must be a non-empty string of at most 64,000 characters. An answer can only be submitted once per offer. Returns **409** if an answer was already submitted or a new offer is awaiting a guest (the answer would be for the wrong offer).

**200 OK**

```json
{
  "status": "saved"
}
```

### GET /sessions/:id/answer

Requires `Authorization: Bearer <hostToken>`. No request body.

**200 OK — answer not yet submitted or expired**

```json
{
  "status": "pending"
}
```

**200 OK — answer available**

```json
{
  "status": "ready",
  "answer": {
    "type": "answer",
    "sdp": "v=0\r\n..."
  }
}
```

### Response headers

Successful session creation, joining, and answer retrieval responses include `Cache-Control: no-store`.
