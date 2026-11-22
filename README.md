# Handshaker 

This "Handshaker" Cloudflare worker server helps devices setup a WebRTC connection. 

## API 

POST /sessions	Host	Create session with Offer
POST /join/:id	Guest	Claim session and receive Offer
PUT /sessions/:id/answer	Guest	Submit Answer using guest token
GET /sessions/:id/answer	Host	Retrieve Answer using host token