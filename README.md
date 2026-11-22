# Handshaker 

This "Handshaker" Cloudflare worker server helps devices setup a WebRTC connection. 

## API 

All request and response bodies below are JSON. Send JSON request bodies with `Content-Type: application/json`. `:id` is the session ID returned when creating a session.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | Anyone | Check service health |
| POST | `/sessions` | Host | Create a session with an offer |
| POST | `/join/:id` | Guest | Claim a session and receive its offer |
| PUT | `/sessions/:id/answer` | Guest | Submit an answer using the guest token |
| GET | `/sessions/:id/answer` | Host | Retrieve the answer using the host token |

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

`expiresIn` is the invitation lifetime in seconds (5 minutes). `expiresAt` is its expiration time in ISO 8601 format. Keep `hostToken` for retrieving the answer.

### POST /join/:id

No request body or authorization required. Only one guest can claim a session.

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

Keep `guestToken` for submitting the answer.

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

`answer.type` must be `"answer"`. `answer.sdp` must be a non-empty string of at most 64,000 characters. An answer can only be submitted once.

**200 OK**

```json
{
  "status": "saved"
}
```

### GET /sessions/:id/answer

Requires `Authorization: Bearer <hostToken>`. No request body.

**200 OK — answer not yet submitted**

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
