# Hecate Gateway

The server behind the Hecate apps. Your iPhone, iPad and Mac talk to **only this**; it talks to your
LLM servers (LM Studio, Ollama, llama.cpp), speech models, and the Hermes agent. It owns accounts, chats,
streaming, model routing, memory and attachments.

```
 Hecate app (SwiftUI)  ──LAN──▶  HECATE GATEWAY  ──▶  LM Studio on the gaming PC   (fast tier)
                                  accounts · chats     LM Studio on the MacBook      (smart tier)
                                  streaming · memory   Whisper / embeddings servers  (optional)
                                  attachments · agents Hermes Agent                  (agent worker)
```

Zero dependencies: plain Node.js 22 (built-in SQLite and `fetch`). Nothing to compile, nothing to `npm install`.
It runs fine on a 2012 mini PC; it does no model inference itself.

## Running in the background

Run `scripts/install.sh` once. It puts `hecate` on your PATH (works from any folder), does first-time setup, and starts the gateway in the background. Closing the terminal does not stop it.

```
hecate            open the menu (also: hecate gateway)
hecate start      start in the background; keeps running until you stop it
hecate stop       stop it
hecate restart    restart it
hecate status     running or not, port, start-at-login state
hecate logs [-f]  show the log (-f follows it)
hecate autostart on|off   start automatically when you log in
hecate hermes     connect, test or disconnect the Hermes agent
```

Notes: the log is `data/gateway.log`. On macOS, start-at-login cannot read the Desktop, Documents or Downloads folders, so keep the gateway folder somewhere like `~/hecate-gateway` if you want that. If you started the gateway with `npm run dev`, stop that first.

## The `hecate` command (control panel)

A keyboard-driven menu for everything you would otherwise do with curl: pick your **Fast** and **Smart** models,
add or refresh LM Studio servers, fix what each model can do, change settings, invite people, back up, start the gateway.

```bash
cd hecate-gateway
npm link            # once: puts `hecate` on your PATH (needs Node 22.13+)
hecate              # open the menu  (↑↓ move, enter choose, esc back, q quit)
hecate models       # jump straight to the model picker
hecate start        # start the gateway in this window
hecate status       # what is running, which models are picked
hecate list         # list models and which are picked
```

Without `npm link`, use `npm run hecate` from this folder. It works over SSH and on the running gateway (no restart
needed for model picks and settings). Once you have picked a Fast and a Smart model, those are the only models used for
normal chat; other models are used only when a request names one explicitly. Settings: `model_fast`, `model_smart`.

## Quick start

**Easiest: the guided setup** (Linux, macOS; works over SSH)

```bash
npm run setup      # walks you through sign-in, network, LM Studio servers, optional speech/Hermes
npm start
```

It writes `.env`, connects to each LM Studio machine, shows which models it found and what they can do, and
prints the address to put in the app. Run it again any time to change answers.

**Or by hand — Option A: Docker** (also installs ffmpeg and PDF tools for you)

```bash
cp .env.example .env        # set HECATE_DEV_LOGIN=1 for now (see "Signing in")
docker compose up -d --build
```

**Option B: Node on Ubuntu Server** (x86-64 or ARM; developed and tested on Linux)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg poppler-utils unzip   # the last three are optional but recommended
cp .env.example .env
npm start
```

For a service that survives reboots, use `hecate-gateway.service` (instructions at the top of that file).
On start-up the gateway prints its LAN address and warns about anything missing.

### First run (copy and paste)

```bash
G=http://localhost:8080

# 1. Sign in. The first person to sign in becomes the owner.
TOKEN=$(curl -s $G/v1/auth/dev -d '{"name":"owen"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
H="Authorization: Bearer $TOKEN"

# 2. Add your model servers. Tier "fast" is the default for most turns, "smart" is for hard tasks / "think harder".
curl -s $G/v1/admin/servers -H "$H" -d '{"name":"gaming-pc","base_url":"http://192.168.1.50:1234","default_tier":"fast"}'
curl -s $G/v1/admin/servers -H "$H" -d '{"name":"macbook","base_url":"http://192.168.1.60:1234","default_tier":"smart"}'

# 3. Look at what was discovered. Fix tiers and capabilities where the guess is wrong.
curl -s $G/v1/admin/models -H "$H"
curl -s -X PATCH $G/v1/admin/models/MODEL_ID -H "$H" -d '{"tier":"smart","capabilities":["text","vision","reasoning"]}'

# 4. Chat.
CHAT=$(curl -s $G/v1/chats -H "$H" -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -N $G/v1/chats/$CHAT/messages -H "$H" -H 'Accept: text/event-stream' -d '{"text":"Say hi in five words","stream":true}'
```

In LM Studio, turn on **Serve on Local Network** (Developer tab) so the gateway can reach it. The server's address
is `http://<ip>:1234`; with or without a trailing `/v1`, both work.

## Signing in

* **Sign in with Apple** (the real thing): set `HECATE_APPLE_BUNDLE_ID` to your app's bundle ID. The app sends the
  identity token to `POST /v1/auth/apple`; the gateway verifies Apple's signature, issuer, audience, expiry and
  nonce, then issues its own short-lived access token and a rotating refresh token. The gateway needs internet access to
  fetch Apple's public keys (cached for 6 hours).
* **Developer login**: `HECATE_DEV_LOGIN=1` enables `POST /v1/auth/dev {"name": "..."}` so you can build and test
  without Apple. **Turn it off** before the server is reachable by anyone you do not trust.
* **Who can join**: the first user is the owner. Everyone else needs an invite code
  (`POST /v1/admin/invites`, or on the server: `npm run cli -- invite`), or set `open_signup`.

## How things work

**Model routing.** Each model has a *tier* (`fast` / `smart`) and *capabilities* (`text vision audio video tools
reasoning embedding`), guessed from its name and LM Studio's metadata and editable by you. For every turn the router
ranks healthy models by tier, then by what the attachments need (a photo prefers a vision model), and tries up to
three in order. A server that is asleep (the MacBook) is marked unhealthy within ~15 s and skipped; if a model fails
before producing output the next one is used and the app is told via a `model.fallback` event. "Think harder" =
smart tier + `reasoning_effort: high`.

**Runs and streaming.** A message starts a *run* that lives on the server. Its events are written to a numbered log;
the SSE stream is just a tail of that log. If iOS suspends the app, the run keeps going; the app reconnects with
`GET /v1/runs/{id}/events?after=<last seq>` and misses nothing. Cancelling stops the upstream request and keeps the
partial answer. Thinking streams as `thinking.delta` and is saved with the message. `GET /v1/chats/{id}` includes
`active_run_id` so the app knows whether to reattach. Full event list and semantics: `openapi.yaml`.

**Attachments.** Upload raw bytes (`POST /v1/attachments?filename=...`), then reference the id in a message.

| Kind | Model supports it natively | Otherwise |
|---|---|---|
| Image | `image_url` part | note that the model cannot see (router prefers a vision model) |
| Audio | `input_audio` part (wav/mp3, converted with ffmpeg if needed) | transcript from your Whisper server (`stt_url` setting) |
| Video | `video_url` part (up to `HECATE_NATIVE_VIDEO_MAX_MB`) | sampled frames (ffmpeg) + audio transcript |
| PDF / Word / PowerPoint / Excel / text / code | n/a | text extracted and inlined (cached) |

If a model rejects native audio/video with a 4xx, the gateway retries once with the fallback pipeline on its own.
The app can also pre-extract text on the device and `PUT /v1/attachments/{id}/extracted`.

**Memory.** Per user, listable/editable/deletable through `/v1/memories`. After each turn the fast model extracts
durable facts; relevant ones are added to the prompt (all of them while the store is small, ranked by embedding
similarity once it grows). Load an embedding model on a server (for example `nomic-embed-text`) and it is picked up
automatically; without one, keyword matching is used. Per-chat switch: `use_memory`. Agent chats do not use gateway
memory (Hermes has its own).

**Agents (Hermes).** An agent is a named config backed by a Hermes *profile*. Attach Hermes once:

```bash
curl -s $G/v1/admin/hermes -H "$H" -d '{"url":"http://localhost:8642","api_key":"<API_SERVER_KEY>"}'
```

Create the profile in Hermes first (by default the agent expects `<user>--<agent-name>`; set `hermes_profile` on the
agent to use any existing profile). Tool progress, thinking, approvals and the final answer arrive as normal gateway
events; answer an approval with `POST /v1/runs/{id}/approval`. To make Hermes use **your gateway as its model
provider** (so routing lives in one place), create a key (`POST /v1/admin/api-keys`) and give Hermes the base URL
`http://<gateway>:8080/openai/v1` with that key; models `hecate-fast` and `hecate-smart` are available.

**Admin.** Everything under `/v1/admin/*`: servers, models, users, invites, service keys, settings, Hermes, backup.

## LM Studio

The gateway is set up for LM Studio first. In LM Studio (0.4+): **Developer** tab, start the server, and turn on
**Serve on Local Network** so the mini PC can reach it. If you enabled *Require Authentication*, create an API token
and give it to the gateway when adding the server (setup asks). Models are read from `/api/v1/models` (type,
vision/tool/reasoning flags, loaded state, context length) with automatic fallback to the older `/api/v0` and plain
`/v1/models`. Chats are sent through the OpenAI-compatible `/v1/chat/completions`, which is what carries
conversation history, image, audio and video parts. Turn on *Just-in-time model loading* so a request for an unloaded
model loads it (the first reply is slower; the first-token timeout is generous for this).

## Configuration

All options are in `.env.example` with comments. Admin-changeable at runtime (`PATCH /v1/admin/settings`):
`open_signup`, `memory_extraction`, `memory_extract_every`, `memory_embeddings`, `title_generation`, `title_regen_every`, `stt_url`, `stt_model`, `embedding_model_id`,
`default_system_prompt`.

## Operating it

* **Data** lives in `HECATE_DATA_DIR` (`hecate.db`, `files/`, `secret.key`). Back up the whole folder; losing
  `secret.key` makes stored server keys unreadable. `scripts/backup.sh <folder>` makes consistent nightly backups.
* **Disk**: videos are stored as uploaded. Delete files you do not need from `data/files/`, or delete the chat in the app.
* **Security**: HTTP only for now. Put Caddy in front for HTTPS when you want it (`reverse_proxy localhost:8080`; SSE
  works, nothing to configure). Access tokens last 15 minutes, refresh tokens rotate and theft is detected,
  every query is scoped to the signed-in user, model-server and Hermes keys are encrypted at rest (AES-256-GCM).
  The iOS app needs an App Transport Security exception until HTTPS is on.
* **Tests**: `npm test` (37 tests, uses fake model servers, no real models needed).

## Known limits and things not yet verified against real systems

* A gateway restart fails in-flight runs (the partial text is kept and the app sees `run.failed`); they are not resumed.
* The exact JSON the real LM Studio expects for **native video** is unverified here. The default is a `video_url`
  data-URI part. If your LM Studio build wants something else, set the model's `options.video_style` to `"frames"`
  (always sample frames) and tell me what format works.
* Hermes **sessions mode** (`hermes_mode: "sessions"`) guesses the request body (`{"message": ...}`); the default
  `completions` mode uses the verified OpenAI-compatible endpoint. Setting a new profile's API key programmatically is not possible yet:
  create the profile in Hermes, then pass its key as `hermes_api_key` on the agent.
* Sign in with Apple is tested with locally generated keys, not with a real Apple token yet.
* Chat titles are generated a few seconds after the first answer; the app should refetch the chat then.
* One process, one SQLite file: built for a household, not for hundreds of users.

## Layout

```
src/server.js    HTTP server, routing, auth gate        src/runs.js     run manager, event log, prompt building
src/routes.js    user API    src/admin.js  admin API    src/servers.js  model registry, health, routing
src/openai.js    OpenAI-compatible passthrough          src/media.js    uploads, extraction, audio/video pipeline
src/auth.js      Apple sign-in, tokens, sessions        src/memory.js   memory store, retrieval, extraction
src/hermes.js    agent adapter (swappable)              src/llm.js      streaming client for OpenAI-style servers
openapi.yaml     the API contract (checked against the real routes by a test)
```


## Install in one step (mini PC / server)

```bash
git clone https://github.com/spacecadetbot/hecate.git ~/.hecate/gateway && bash ~/.hecate/gateway/scripts/install.sh
```

This checks Node 22+, puts `hecate` on your PATH, then runs `hecate gateway`: a short setup, then it
starts in the background and (if you agree) at every login/boot. On Linux it also enables
`loginctl enable-linger` so it survives logout. After that, run `hecate` any time to manage it.

**Update:** `cd ~/.hecate/gateway && git pull && hecate restart` (or re-run `scripts/install.sh`).
